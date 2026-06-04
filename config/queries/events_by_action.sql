SELECT
  action,
  COUNT(*) AS event_count
FROM serverless_stable_3rlc3e_catalog.app_telemetry.app_idle_events
WHERE event_time >= current_timestamp() - INTERVAL 7 DAYS
GROUP BY action
ORDER BY event_count DESC
