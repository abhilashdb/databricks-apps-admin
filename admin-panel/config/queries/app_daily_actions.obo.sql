SELECT
  DATE(event_time)  AS event_date,
  action,
  COUNT(*)          AS event_count
FROM {{telemetry_catalog}}.{{telemetry_schema}}.app_idle_events
WHERE event_time >= current_timestamp() - INTERVAL 14 DAYS
GROUP BY DATE(event_time), action
ORDER BY event_date DESC, event_count DESC
