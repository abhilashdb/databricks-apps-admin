SELECT
  action,
  COUNT(*) AS event_count
FROM {{telemetry_catalog}}.{{telemetry_schema}}.app_idle_events
WHERE event_time >= current_timestamp() - INTERVAL 7 DAYS
GROUP BY action
ORDER BY event_count DESC
