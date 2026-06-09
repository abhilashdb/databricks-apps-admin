SELECT
  event_time,
  app_name,
  creator,
  action,
  reason,
  CAST(traffic_count AS BIGINT)   AS traffic_count,
  idle_threshold_minutes,
  CAST(uptime_hours AS DOUBLE)    AS uptime_hours,
  compute_state,
  dry_run
FROM {{telemetry_catalog}}.{{telemetry_schema}}.app_idle_events
ORDER BY event_time DESC
LIMIT 200
