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
FROM serverless_stable_3rlc3e_catalog.app_telemetry.app_idle_events
ORDER BY event_time DESC
LIMIT 200
