# Databricks notebook source
# Databricks Apps Scale-to-Zero Monitor
#
# Two simple rules per app (configured in app_schedule Delta table):
#
#   always_on              — exception flag: never stop this app (auto-start if stopped)
#   idle_threshold_minutes — stop when no traffic for this many minutes (default 30)
#   force_stop_hour        — UTC hour (0-23) to force-stop regardless of traffic (default 22)
#   traffic_signal         — proxy (Dash/Flask) | streamlit | any
#
# Stop priority (highest first):
#   1. always_on=true      → never stop
#   2. force_stop_hour     → stop at that UTC hour regardless of traffic
#   3. idle_threshold      → stop when idle for N minutes
#
# Every assessment is written to app_idle_events for auditing.
# Alert on long uptime:
#   SELECT * FROM app_telemetry.app_idle_events
#   WHERE action = 'kept_active' AND uptime_hours > 1
#
# Prerequisites — enable telemetry on each app:
#   databricks apps update <app-name> --json '{
#     "telemetry_export_destinations": [{
#       "unity_catalog": {
#         "logs_table":    "<catalog>.app_telemetry.otel_logs",
#         "metrics_table": "<catalog>.app_telemetry.otel_metrics",
#         "traces_table":  "<catalog>.app_telemetry.otel_traces"
#       }
#     }]
#   }' --profile <profile>

import os
import traceback
from datetime import datetime, timezone, timedelta
from pyspark.sql.types import (  # noqa: F821
    StructType, StructField,
    TimestampType, StringType, LongType, IntegerType, DoubleType, BooleanType,
)

# ---------------------------------------------------------------------------
# Parameters — job parameters take precedence; env vars are a local-dev fallback
# ---------------------------------------------------------------------------
def _param(name: str, default: str = "") -> str:
    try:
        val = dbutils.widgets.get(name)  # noqa: F821
        return val.strip() if val.strip() else default
    except Exception:
        return os.environ.get(name.upper(), default)

IDLE_THRESHOLD_MINUTES = int(_param("idle_threshold_minutes", "30"))
FORCE_STOP_HOUR        = int(_param("force_stop_hour", "22"))   # default 22:00 UTC
TELEMETRY_CATALOG      = _param("telemetry_catalog", "serverless_stable_3rlc3e_catalog")
TELEMETRY_SCHEMA       = _param("telemetry_schema", "app_telemetry")
TELEMETRY_PREFIX       = _param("telemetry_table_prefix", "")
APP_FILTER             = _param("app_filter", "")
DRY_RUN                = _param("dry_run", "false").lower() == "true"
AUTO_ENABLE_TELEMETRY  = _param("auto_enable_telemetry", "true").lower() == "true"
TIMEZONE               = _param("timezone", "Asia/Kolkata")  # IANA tz for force_stop_hour

# ---------------------------------------------------------------------------
# Derived table references
# ---------------------------------------------------------------------------
_prefix = f"{TELEMETRY_PREFIX}_" if TELEMETRY_PREFIX else ""
OTEL_LOGS_TABLE     = f"`{TELEMETRY_CATALOG}`.`{TELEMETRY_SCHEMA}`.`{_prefix}otel_logs`"
OTEL_METRICS_TABLE  = f"`{TELEMETRY_CATALOG}`.`{TELEMETRY_SCHEMA}`.`{_prefix}otel_metrics`"
APP_SCHEDULE_TABLE  = f"`{TELEMETRY_CATALOG}`.`{TELEMETRY_SCHEMA}`.`app_schedule`"
APP_EVENTS_TABLE    = f"`{TELEMETRY_CATALOG}`.`{TELEMETRY_SCHEMA}`.`app_idle_events`"

# ---------------------------------------------------------------------------
# SDK client
# ---------------------------------------------------------------------------
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

# ---------------------------------------------------------------------------
# Telemetry auto-configuration
# Calls the Apps Update API (PATCH /api/2.0/apps/{name}) when an app is
# found without telemetry configured, using the default catalog/schema.
# ---------------------------------------------------------------------------
def _enable_telemetry(app_name: str) -> bool:
    """Configure telemetry export on an app that doesn't have it set up yet."""
    if DRY_RUN:
        print(f"  [DRY RUN] Would enable telemetry on '{app_name}' "
              f"→ {TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}")
        return False  # don't actually configure in dry-run

    _p = f"{TELEMETRY_PREFIX}_" if TELEMETRY_PREFIX else ""
    payload = {
        "telemetry_export_destinations": [{
            "unity_catalog": {
                "logs_table":    f"{TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}.{_p}otel_logs",
                "metrics_table": f"{TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}.{_p}otel_metrics",
                "traces_table":  f"{TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}.{_p}otel_traces",
            }
        }]
    }
    try:
        # Prefer the SDK API client (works in all recent SDK versions)
        w.api_client.do("PATCH", f"/api/2.0/apps/{app_name}", body=payload)
        print(f"  Telemetry configured → {TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}")
        return True
    except AttributeError:
        # Fallback for older SDK: use dbutils notebook context to get a token
        import json, urllib.request
        ctx   = dbutils.notebook.entry_point.getDbutils().notebook().getContext()  # noqa: F821
        token = ctx.apiToken().getOrElse(None)
        host  = ctx.apiUrl().getOrElse(None)
        if not token or not host:
            raise RuntimeError("Cannot get API token from notebook context")
        data = json.dumps(payload).encode()
        req  = urllib.request.Request(
            f"{host}/api/2.0/apps/{app_name}",
            data=data,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="PATCH",
        )
        with urllib.request.urlopen(req) as resp:
            resp.read()
        print(f"  Telemetry configured → {TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}")
        return True
    except Exception as err:
        print(f"  Warning: could not configure telemetry: {err}")
        return False


print("=" * 60)
print("Apps Scale-to-Zero Monitor")
print(f"  Default idle threshold : {IDLE_THRESHOLD_MINUTES}m")
print(f"  Default force stop     : {FORCE_STOP_HOUR:02d}:00 UTC")
print(f"  Telemetry table        : {OTEL_LOGS_TABLE}")
print(f"  Schedule table         : {APP_SCHEDULE_TABLE}")
print(f"  Events table           : {APP_EVENTS_TABLE}")
print(f"  App filter             : {APP_FILTER or '(all apps)'}")
print(f"  Framework detection    : auto (tries proxy then streamlit)")
print(f"  Auto-enable telemetry  : {AUTO_ENABLE_TELEMETRY}")
print(f"  Timezone               : {TIMEZONE}")
print(f"  Dry run                : {DRY_RUN}")
print("=" * 60)
print()

# ---------------------------------------------------------------------------
# Ensure helper tables exist
# ---------------------------------------------------------------------------
spark.sql(f"""
    CREATE TABLE IF NOT EXISTS {APP_SCHEDULE_TABLE} (
        app_name               STRING,
        always_on              BOOLEAN,
        idle_threshold_minutes INT,
        force_stop_hour        INT,
        traffic_signal         STRING,
        notes                  STRING,
        updated_at             TIMESTAMP
    )
    USING DELTA
    COMMENT 'Per-app scale-to-zero config. always_on=exception; force_stop_hour=UTC hour (0-23).'
""")  # noqa: F821

spark.sql(f"""
    CREATE TABLE IF NOT EXISTS {APP_EVENTS_TABLE} (
        event_time             TIMESTAMP,
        app_name               STRING,
        creator                STRING,
        compute_state          STRING,
        traffic_count          LONG,
        idle_threshold_minutes INT,
        uptime_hours           DOUBLE,
        action                 STRING,
        reason                 STRING,
        dry_run                BOOLEAN
    )
    USING DELTA
    COMMENT 'Audit log of idle assessments and start/stop actions.'
""")  # noqa: F821

print("Config and events tables ready.\n")

# ---------------------------------------------------------------------------
# Load per-app config (most-recently-updated row wins on duplicates)
# ---------------------------------------------------------------------------
app_config = {}
try:
    cfg_rows = spark.sql(  # noqa: F821
        f"""
        SELECT * EXCEPT (rn)
        FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY app_name ORDER BY updated_at DESC NULLS LAST) AS rn
            FROM {APP_SCHEDULE_TABLE}
        )
        WHERE rn = 1
        """
    ).collect()
    app_config = {r["app_name"]: r.asDict() for r in cfg_rows}
    if app_config:
        print(f"Loaded config for: {list(app_config.keys())}")
    else:
        print("No per-app config found (using job defaults).")
except Exception as e:
    print(f"Warning: could not read {APP_SCHEDULE_TABLE}: {e}")
print()

# ---------------------------------------------------------------------------
# Traffic detection — two-tier approach
#
# Tier 1 (preferred): otel_metrics http.server.duration histogram.
#   Emitted by opentelemetry-instrument (Dash, Flask, Streamlit).
#   Framework-agnostic; no log-line parsing needed.
#
# Tier 2 (fallback): otel_logs body pattern matching.
#   For apps not yet instrumented with opentelemetry-instrument.
# ---------------------------------------------------------------------------

def _metrics_traffic(app_name: str, threshold_min: int) -> tuple:
    """
    Check http.server.duration metric.
    Returns (total_alltime, recent_in_window) or (None, None) on error.
    """
    try:
        total = spark.sql(  # noqa: F821
            f"""
            SELECT COALESCE(SUM(histogram.count), 0) AS cnt
            FROM {OTEL_METRICS_TABLE}
            WHERE service_name = '{app_name}'
              AND name = 'http.server.duration'
            """
        ).collect()[0]["cnt"]

        if total == 0:
            return 0, 0

        recent = spark.sql(  # noqa: F821
            f"""
            SELECT COALESCE(SUM(histogram.count), 0) AS cnt
            FROM {OTEL_METRICS_TABLE}
            WHERE service_name = '{app_name}'
              AND name = 'http.server.duration'
              AND time >= current_timestamp() - INTERVAL {threshold_min} MINUTES
            """
        ).collect()[0]["cnt"]

        return int(total), int(recent)
    except Exception as e:
        print(f"  Warning: metrics query failed ({e}) — falling back to logs")
        return None, None


def _otel_instrumentation_status(app_name: str) -> str:
    """
    Infer opentelemetry-instrument presence from metric availability.

    Returns:
      'ok'                      — http.server.duration present → fully instrumented
      'no_http_instrumentation' — system metrics present but no HTTP metric
                                  → OTel running but framework package missing in requirements.txt
      'no_otel_config'          — no metrics at all → opentelemetry-instrument
                                  not in app.yaml command
    """
    try:
        has_http = spark.sql(  # noqa: F821
            f"SELECT COUNT(*) AS cnt FROM {OTEL_METRICS_TABLE}"
            f" WHERE service_name = '{app_name}' AND name = 'http.server.duration'"
        ).collect()[0]["cnt"]
        if has_http > 0:
            return "ok"

        has_system = spark.sql(  # noqa: F821
            f"SELECT COUNT(*) AS cnt FROM {OTEL_METRICS_TABLE}"
            f" WHERE service_name = '{app_name}' AND name LIKE 'system.%'"
        ).collect()[0]["cnt"]

        return "no_http_instrumentation" if has_system > 0 else "no_otel_config"
    except Exception:
        return "unknown"


# Fallback log-based signals (used when otel_metrics unavailable)
_LOG_SIGNALS = {
    "proxy": (
        "variant_get(body, '$', 'string') LIKE '%127.0.0.1%'"
        " AND variant_get(body, '$', 'string') LIKE '%HTTP/1%'"
    ),
    "streamlit": (
        "variant_get(body, '$', 'string') LIKE '%127.0.0.1%'"
        " AND variant_get(body, '$', 'string') NOT LIKE '%/_stcore/health%'"
        " AND variant_get(body, '$', 'string') NOT LIKE '%/favicon%'"
    ),
}

def _logs_traffic(app_name: str, threshold_min: int) -> tuple:
    """Fallback: detect traffic from otel_logs body patterns."""
    for signal, where in _LOG_SIGNALS.items():
        total = spark.sql(  # noqa: F821
            f"""
            SELECT COUNT(*) AS cnt
            FROM {OTEL_LOGS_TABLE}
            WHERE service_name = '{app_name}'
              AND {where}
            """
        ).collect()[0]["cnt"]
        if total > 0:
            recent = spark.sql(  # noqa: F821
                f"""
                SELECT COUNT(*) AS cnt
                FROM {OTEL_LOGS_TABLE}
                WHERE service_name = '{app_name}'
                  AND time >= current_timestamp() - INTERVAL {threshold_min} MINUTES
                  AND {where}
                """
            ).collect()[0]["cnt"]
            return signal, int(total), int(recent)
    return "proxy", 0, 0

# ---------------------------------------------------------------------------
# Uptime helper
# ---------------------------------------------------------------------------
def _uptime_hours(app_name: str):
    try:
        row = spark.sql(  # noqa: F821
            f"""
            SELECT MAX(event_time) AS last_stopped
            FROM {APP_EVENTS_TABLE}
            WHERE app_name = '{app_name}'
              AND action LIKE 'stopped%'
            """
        ).collect()[0]
        last_stopped = row["last_stopped"]
        if last_stopped is None:
            return None
        delta = datetime.utcnow() - last_stopped.replace(tzinfo=None)
        return round(delta.total_seconds() / 3600, 2)
    except Exception:
        return None

# ---------------------------------------------------------------------------
# Discover apps
# ---------------------------------------------------------------------------
all_apps = list(w.apps.list())

def _state(app) -> str:
    return str(app.compute_status.state).upper() if app.compute_status else "UNKNOWN"

def _app_health(app) -> str:
    """Return the application health state (distinct from compute state).
    apps.list() often omits app_status; fall back to deployment checks."""
    # Try app_status from the object (present on apps.get(), often absent on apps.list())
    if app.app_status and getattr(app.app_status, "state", None):
        return str(app.app_status.state).upper()
    # No active deployment = no source code deployed → compute is wasted
    if not getattr(app, "active_deployment", None):
        return "UNAVAILABLE"
    # Deployment failed
    dep_state = str(getattr(getattr(app.active_deployment, "status", None), "state", "") or "").upper()
    if dep_state and dep_state not in ("SUCCEEDED", ""):
        return dep_state
    return ""

def _creator(app) -> str:
    return getattr(app, "creator", None) or ""

def _is_unhealthy(health: str) -> bool:
    """True when the app status indicates a problem (crashed / not deployed / deploy failed)."""
    # UNAVAILABLE covers: no source deployed, app crashed on start, or proxy can't reach the process
    return any(s in health for s in ("CRASH", "ERROR", "FAILED", "UNAVAILABLE"))

def _consecutive_unhealthy(app_name: str, n: int = 2) -> bool:
    """Return True if the app has recorded n or more consecutive unhealthy events."""
    try:
        rows = spark.sql(  # noqa: F821
            f"""
            SELECT action
            FROM {APP_EVENTS_TABLE}
            WHERE app_name = '{app_name}'
              AND action IN ('stopped_unhealthy', 'skipped_unhealthy_first')
            ORDER BY event_time DESC
            LIMIT {n}
            """
        ).collect()
        return len(rows) >= n
    except Exception:
        return False

active_apps  = [a for a in all_apps if "ACTIVE"  in _state(a)]
stopped_apps = [a for a in all_apps if "STOPPED" in _state(a) and a.name in app_config]

if APP_FILTER:
    filter_names = {n.strip() for n in APP_FILTER.split(",") if n.strip()}
    active_apps  = [a for a in active_apps  if a.name in filter_names]
    stopped_apps = [a for a in stopped_apps if a.name in filter_names]

# ---------------------------------------------------------------------------
# Auto-register new apps (default: idle check + force stop at FORCE_STOP_HOUR)
# ---------------------------------------------------------------------------
_new = [a for a in all_apps if a.name not in app_config]
if _new:
    for a in _new:
        safe_name = a.name.replace("'", "''")
        spark.sql(  # noqa: F821
            f"INSERT INTO {APP_SCHEDULE_TABLE} (app_name, always_on, idle_threshold_minutes, force_stop_hour, updated_at)"
            f" VALUES ('{safe_name}', false, {IDLE_THRESHOLD_MINUTES}, {FORCE_STOP_HOUR}, current_timestamp())"
        )
    cfg_rows = spark.sql(  # noqa: F821
        f"""
        SELECT * EXCEPT (rn)
        FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY app_name ORDER BY updated_at DESC NULLS LAST) AS rn
            FROM {APP_SCHEDULE_TABLE}
        )
        WHERE rn = 1
        """
    ).collect()
    app_config = {r["app_name"]: r.asDict() for r in cfg_rows}
    stopped_apps = [a for a in all_apps if "STOPPED" in _state(a) and a.name in app_config]
    print(f"Auto-registered {len(_new)} new app(s): {[a.name for a in _new]}\n")

print(f"Active apps            ({len(active_apps)}): {[a.name for a in active_apps]}")
print(f"Stopped + tracked      ({len(stopped_apps)}): {[a.name for a in stopped_apps]}")
print()

if not active_apps and not stopped_apps:
    print("No apps to monitor.")
    dbutils.notebook.exit("no_apps")  # noqa: F821

# ---------------------------------------------------------------------------
# Verify telemetry table
# ---------------------------------------------------------------------------
try:
    spark.sql(f"DESCRIBE TABLE {OTEL_LOGS_TABLE}").collect()  # noqa: F821
    print(f"Telemetry table OK: {OTEL_LOGS_TABLE}\n")
except Exception as err:
    raise RuntimeError(
        f"Cannot read telemetry table {OTEL_LOGS_TABLE}.\n"
        f"Ensure the schema exists and telemetry is enabled for your apps.\n"
        f"Error: {err}"
    )

# ---------------------------------------------------------------------------
# Current local hour for force-stop check (converted to configured timezone)
# force_stop_hour is stored as a local-time hour (e.g. 22 = 10 PM IST)
# ---------------------------------------------------------------------------
try:
    import pytz
    _tz      = pytz.timezone(TIMEZONE)
    now_local = datetime.utcnow().replace(tzinfo=pytz.utc).astimezone(_tz)
    now_hour  = now_local.hour
    print(f"Current time: {now_local.strftime('%H:%M %Z')} (force-stop at {now_hour:02d}:xx vs threshold {FORCE_STOP_HOUR:02d}:00)")
except Exception as _tz_err:
    print(f"Warning: timezone '{TIMEZONE}' not available ({_tz_err}), falling back to UTC")
    now_local = datetime.utcnow()
    now_hour  = now_local.hour

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
started, stopped, kept, skipped = [], [], [], []
events = []
run_time = datetime.utcnow()

def _record(app, action, reason, traffic_count=None, threshold=None, uptime_hours=None):
    events.append({
        "event_time":             run_time,
        "app_name":               app.name,
        "creator":                _creator(app),
        "compute_state":          _state(app),
        "traffic_count":          traffic_count,
        "idle_threshold_minutes": threshold,
        "uptime_hours":           uptime_hours,
        "action":                 action,
        "reason":                 reason,
        "dry_run":                DRY_RUN,
    })

# --- Phase 1: auto-start stopped apps with always_on=true ---
for app in stopped_apps:
    name = app.name
    cfg  = app_config.get(name, {})
    print(f"--- {name} (STOPPED) ---")

    if cfg.get("always_on"):
        if DRY_RUN:
            print(f"  [DRY RUN] Would start '{name}' — always_on exception")
        else:
            print(f"  Starting '{name}' — always_on exception...")
            w.apps.start(name)
            print(f"  Started.")
        started.append(name)
        _record(app, "started_always_on", "always_on=true, app was stopped")
    else:
        print(f"  No auto-start (always_on=false) — leaving stopped.")
        skipped.append(name)
        _record(app, "skipped_stopped", "always_on=false, no auto-start")

    print()

# --- Phase 2: check active apps ---
for app in active_apps:
    name      = app.name
    cfg       = app_config.get(name, {})
    threshold = cfg.get("idle_threshold_minutes") or IDLE_THRESHOLD_MINUTES
    fsh_raw   = cfg.get("force_stop_hour")
    fsh       = int(fsh_raw) if fsh_raw is not None else FORCE_STOP_HOUR

    print(f"--- {name} (ACTIVE) [idle={threshold}m, force_stop={fsh:02d}:00 UTC] ---")

    # 1. Exception flag — never stop
    if cfg.get("always_on"):
        uptime = _uptime_hours(name)
        print(f"  KEEP — always_on exception. Uptime: {uptime}h")
        kept.append(name)
        _record(app, "kept_always_on", "always_on=true", uptime_hours=uptime)
        print()
        continue

    # 1b. Safety net — stop unhealthy apps even when telemetry is unavailable.
    #     If the app health is bad this run AND was bad last run → stop compute.
    #     This protects against crashed apps running indefinitely at cost.
    health = _app_health(app)
    if _is_unhealthy(health):
        print(f"  App health: {health} — checking consecutive unhealthy runs...")
        if _consecutive_unhealthy(name, n=2):
            if DRY_RUN:
                print(f"  [DRY RUN] Would stop '{name}' — unhealthy for ≥2 consecutive runs")
                action = "dry_run_would_stop"
            else:
                print(f"  Stopping '{name}' — unhealthy for ≥2 consecutive runs (safety net)...")
                w.apps.stop(name)
                print(f"  Stopped.")
                action = "stopped_unhealthy"
            stopped.append(name)
            _record(app, action, f"app health={health}, unhealthy ≥2 consecutive runs")
        else:
            # First time unhealthy — record it but wait one more run before stopping
            print(f"  App health: {health} — first occurrence, will stop if persists next run.")
            skipped.append(name)
            _record(app, "skipped_unhealthy_first", f"app health={health}, waiting for confirmation")
        print()
        continue

    # 2. Force stop — current hour has reached the configured stop hour
    if now_hour >= fsh:
        if DRY_RUN:
            print(f"  [DRY RUN] Would force-stop '{name}' — {now_hour:02d}:xx UTC >= {fsh:02d}:00 UTC")
            action = "dry_run_would_force_stop"
        else:
            print(f"  Force-stopping '{name}' — {now_hour:02d}:xx UTC >= {fsh:02d}:00 UTC...")
            w.apps.stop(name)
            print(f"  Stopped.")
            action = "stopped_force"
        stopped.append(name)
        _record(app, action, f"force stop at {fsh:02d}:00 UTC, current={now_hour:02d}:xx")
        print()
        continue

    # 3. Idle check — metrics-first, fallback to logs
    try:
        # --- Tier 1: otel_metrics http.server.duration ---
        total_m, recent_m = _metrics_traffic(name, threshold)

        if total_m is not None and total_m > 0:
            # Metrics available and have historical data — use them
            print(f"  Using metrics signal: http.server.duration (total={total_m}, recent={recent_m})")
            total_rows, recent = total_m, recent_m

        elif total_m == 0:
            # Metrics table accessible but no http.server.duration → check instrumentation
            instr_status = _otel_instrumentation_status(name)
            print(f"  No http.server.duration metrics — instrumentation status: {instr_status}")

            if instr_status == "no_http_instrumentation":
                # System metrics present → OTel is running but framework package missing
                skipped.append(name)
                _record(app, "skipped_no_http_instrumentation",
                        "OTel active (system.* metrics present) but no http.server.duration — "
                        "add opentelemetry-instrumentation-flask/tornado to requirements.txt",
                        traffic_count=0, threshold=threshold)
                print()
                continue
            elif instr_status == "no_otel_config":
                # No metrics at all — opentelemetry-instrument not in app.yaml
                # Also ensure otel tables are configured
                if AUTO_ENABLE_TELEMETRY:
                    configured = _enable_telemetry(name)
                    action = "telemetry_enabled" if configured else "skipped_no_otel_config"
                    reason = (
                        f"otel tables configured → {TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}; "
                        "add opentelemetry-instrument to app.yaml command"
                        if configured else
                        "no metrics and telemetry auto-configure failed — check app.yaml"
                    )
                else:
                    action = "skipped_no_otel_config"
                    reason = "no metrics; add opentelemetry-instrument to app.yaml and otel packages to requirements.txt"
                skipped.append(name)
                _record(app, action, reason, traffic_count=0, threshold=threshold)
                print()
                continue
            else:
                # Unknown — fall through to log-based detection
                total_m = None

        if total_m is None:
            # --- Tier 2: fallback to otel_logs ---
            signal, total_rows, recent = _logs_traffic(name, threshold)
            if total_rows == 0:
                if AUTO_ENABLE_TELEMETRY:
                    configured = _enable_telemetry(name)
                    action = "telemetry_enabled" if configured else "skipped_no_telemetry"
                    reason = (
                        f"otel tables configured → {TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}"
                        if configured else
                        "no log traffic rows; telemetry auto-configure failed"
                    )
                else:
                    action = "skipped_no_telemetry"
                    reason = "no traffic in otel_logs (tried proxy + streamlit)"
                skipped.append(name)
                _record(app, action, reason, traffic_count=0, threshold=threshold)
                print()
                continue
            print(f"  Fallback: log signal detected (total={total_rows}, recent={recent})")

        print(f"  Traffic in last {threshold}m: {recent}")

        if recent == 0:
            if DRY_RUN:
                print(f"  [DRY RUN] Would stop '{name}' — idle for {threshold}+ minutes")
                action = "dry_run_would_stop"
            else:
                print(f"  Stopping '{name}' — idle for {threshold}+ minutes...")
                w.apps.stop(name)
                print(f"  Stopped.")
                action = "stopped_idle"
            stopped.append(name)
            _record(app, action, f"0 traffic rows in last {threshold}m",
                    traffic_count=0, threshold=threshold)
        else:
            uptime = _uptime_hours(name)
            uptime_str = f"{uptime}h" if uptime is not None else "unknown"
            print(f"  Active — keeping. Uptime since last stop: {uptime_str}")
            kept.append(name)
            _record(app, "kept_active", f"{recent} traffic rows in last {threshold}m",
                    traffic_count=recent, threshold=threshold, uptime_hours=uptime)

    except Exception as err:
        print(f"  ERROR: {err}")
        print(traceback.format_exc())
        skipped.append(name)
        _record(app, "skipped_error", str(err)[:500], threshold=threshold)

    print()

# ---------------------------------------------------------------------------
# Write events to audit log
# ---------------------------------------------------------------------------
_EVENTS_SCHEMA = StructType([
    StructField("event_time",             TimestampType(), True),
    StructField("app_name",               StringType(),    True),
    StructField("creator",                StringType(),    True),
    StructField("compute_state",          StringType(),    True),
    StructField("traffic_count",          LongType(),      True),
    StructField("idle_threshold_minutes", IntegerType(),   True),
    StructField("uptime_hours",           DoubleType(),    True),
    StructField("action",                 StringType(),    True),
    StructField("reason",                 StringType(),    True),
    StructField("dry_run",                BooleanType(),   True),
])

if events:
    rows = [
        (
            e["event_time"], e["app_name"], e["creator"], e["compute_state"],
            e["traffic_count"],
            int(e["idle_threshold_minutes"]) if e["idle_threshold_minutes"] is not None else None,
            float(e["uptime_hours"]) if e["uptime_hours"] is not None else None,
            e["action"], e["reason"], e["dry_run"],
        )
        for e in events
    ]
    events_df = spark.createDataFrame(rows, _EVENTS_SCHEMA)  # noqa: F821
    events_df.write.format("delta").mode("append").saveAsTable(
        f"{TELEMETRY_CATALOG}.{TELEMETRY_SCHEMA}.app_idle_events"
    )
    print(f"Wrote {len(events)} event(s) to {APP_EVENTS_TABLE}\n")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print("=" * 60)
print(f"SUMMARY  (dry_run={DRY_RUN}, utc_hour={now_hour:02d})")
print(f"  Started  ({len(started)}): {started}")
print(f"  Stopped  ({len(stopped)}): {stopped}")
print(f"  Kept     ({len(kept)}):   {kept}")
print(f"  Skipped  ({len(skipped)}): {skipped}")
print("=" * 60)

prefix = "DRY_RUN " if DRY_RUN else ""
dbutils.notebook.exit(  # noqa: F821
    f"{prefix}started={started} stopped={stopped} kept={kept} skipped={skipped}"
)
