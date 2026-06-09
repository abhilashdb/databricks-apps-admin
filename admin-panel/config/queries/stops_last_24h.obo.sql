-- Count of monitor-triggered stops per app in the last 24 hours.
SELECT
  app_name,
  COUNT(*) AS stop_count
FROM {{telemetry_catalog}}.{{telemetry_schema}}.app_idle_events
WHERE action IN ('stopped_idle', 'stopped_force', 'stopped_unhealthy', 'stopped_outside_window')
  AND event_time >= current_timestamp() - INTERVAL 24 HOURS
  AND dry_run = false
GROUP BY app_name
