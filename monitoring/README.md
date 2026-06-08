# Databricks Apps Scale-to-Zero

Automated idle detection and shutdown for Databricks Apps, with an admin panel for monitoring and control.

## What it does

- **Monitors** all Databricks Apps in a workspace every 15 minutes
- **Detects idle apps** using OpenTelemetry metrics (`http.server.duration`) — works for Dash, Flask, and Streamlit
- **Stops idle apps** when no user traffic is detected for a configurable period
- **Force-stops** all apps at a configurable UTC hour (default 22:00)
- **Auto-enables telemetry export destinations** (the otel UC tables link) on apps missing it — but app developers still need to add `opentelemetry-instrument` to their `app.yaml` command
- **Flags missing instrumentation** when apps lack the `opentelemetry-instrument` wrapper
- **Admin panel** for live status, strategy management, cost visibility, and setup guidance

## Architecture

```
apps-scale-to-zero/          ← This repo (DABs monitoring job)
  src/scale_to_zero.py       ← Main monitoring notebook
  databricks.yml             ← Bundle config
  install.sh                 ← Bootstrap script for new workspaces

scale-to-zero-admin/         ← Admin panel (Databricks AppKit)
  (admin-panel branch)
```

## Quick start — fresh workspace

```bash
./install.sh \
  --profile <databricks-cli-profile> \
  --catalog  <unity-catalog-name>    \   # default: main
  --schema   <schema-name>           \   # default: app_telemetry
  --dbu-rate 0.75                        # $/DBU for cost estimates
```

The script:
1. Creates the telemetry schema (`<catalog>.<schema>`)
2. Deploys the monitoring job (runs every 15 min)
3. Deploys the admin panel app
4. Registers the SQL warehouse resource on the admin app (required for OBO SQL queries)
5. Grants `databricks-sql-access` entitlement to the admin app service principal

### Prerequisites
- Databricks CLI authenticated (`databricks configure --profile <name>`)
- Node.js ≥ 18 and npm (for admin panel build)
- Unity Catalog enabled workspace
- A SQL warehouse

## App schedule strategies

Configured per-app in the `app_schedule` Delta table, or via the admin panel UI.

| `always_on` | `force_stop_hour` | `idle_threshold_minutes` | Behaviour |
|---|---|---|---|
| `true`  | any | any | Never stops. Auto-restarts if stopped. |
| `false` | e.g. `22` | e.g. `30` | Stops when idle for 30m, or at 22:00 UTC (whichever comes first) |
| `false` | `null` | e.g. `30` | Stops only when idle (no scheduled stop) |
| `false` | e.g. `22` | `null` | Stops only at 22:00 UTC (no idle check) |

## Telemetry requirements (for app developers)

The monitor uses `otel_metrics.http.server.duration` to detect user traffic. Two things are needed:

**1. App developer must add to `app.yaml`** — the monitor cannot do this automatically:
```yaml
command: ['opentelemetry-instrument', 'python', 'app.py']   # Dash
# or
command: ['opentelemetry-instrument', 'flask', '--app', 'app.py', 'run', '--no-reload']  # Flask
# or
command: ['opentelemetry-instrument', 'streamlit', 'run', 'app.py',
          '--server.enableCORS', 'false', '--server.enableXsrfProtection', 'false']  # Streamlit
env:
  - name: OTEL_TRACES_SAMPLER
    value: 'always_on'
```

**2. Telemetry export destinations** — auto-configured by the monitor on first encounter (the UC tables link). App developers do not need to do this manually.

See the **Help** tab in the admin panel for per-framework setup instructions.

## Delta tables created

| Table | Purpose |
|---|---|
| `app_schedule` | Per-app config (strategy, stop times) |
| `app_idle_events` | Audit log of every monitoring decision |
| `otel_logs` | App stdout logs (OpenTelemetry) |
| `otel_metrics` | App metrics incl. `http.server.duration` |
| `otel_traces` | App HTTP spans |

## Key events logged

| Action | Meaning |
|---|---|
| `stopped_idle` | Stopped — no traffic for N minutes |
| `stopped_force` | Stopped — force-stop hour reached |
| `stopped_unhealthy` | Stopped — app health bad for 2+ runs |
| `kept_active` | Kept running — traffic detected |
| `skipped_no_otel_config` | Skipped — no OTel metrics (add `opentelemetry-instrument` to app.yaml) |
| `skipped_no_http_instrumentation` | Skipped — OTel running but no HTTP metrics (add framework package) |
| `telemetry_enabled` | Auto-configured otel export destinations |

## SQL alert examples

```sql
-- Apps that can't be monitored (missing instrumentation)
SELECT app_name, last_action, last_checked
FROM app_telemetry.telemetry_status  -- via admin panel query
WHERE last_action IN ('skipped_no_otel_config', 'skipped_no_http_instrumentation');

-- Long-running apps (uptime alert)
SELECT app_name, uptime_hours, event_time
FROM app_telemetry.app_idle_events
WHERE action = 'kept_active' AND uptime_hours > 2;

-- Cost trend (last 30 days)
SELECT usage_metadata.app_name, SUM(usage_quantity) AS dbus
FROM system.billing.usage
WHERE billing_origin_product = 'APPS'
  AND usage_date >= CURRENT_DATE - INTERVAL 30 DAYS
GROUP BY 1 ORDER BY 2 DESC;
```
