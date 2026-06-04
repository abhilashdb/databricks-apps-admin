-- Per-app telemetry configuration status (last known action).
-- action tells whether metrics are flowing or something is missing.
SELECT
  s.app_name,
  e.action                  AS last_action,
  e.reason                  AS last_reason,
  e.event_time              AS last_checked
FROM serverless_stable_3rlc3e_catalog.app_telemetry.app_schedule s
LEFT JOIN (
  SELECT app_name, action, reason, event_time,
    ROW_NUMBER() OVER (PARTITION BY app_name ORDER BY event_time DESC) AS rn
  FROM serverless_stable_3rlc3e_catalog.app_telemetry.app_idle_events
  WHERE action IN (
    'skipped_no_otel_config',
    'skipped_no_http_instrumentation',
    'skipped_no_telemetry',
    'telemetry_enabled',
    'kept_active',
    'stopped_idle',
    'stopped_force',
    'kept_always_on',
    'kept_scheduled'
  )
) e ON s.app_name = e.app_name AND e.rn = 1
WHERE s.app_name IS NOT NULL
ORDER BY s.app_name
