SELECT
  app_name,
  COALESCE(always_on, false)                        AS always_on,
  COALESCE(idle_threshold_minutes, 30)              AS idle_threshold_minutes,
  COALESCE(force_stop_hour, 22)                     AS force_stop_hour,
  notes,
  updated_at
FROM {{telemetry_catalog}}.{{telemetry_schema}}.app_schedule
WHERE app_name IS NOT NULL
ORDER BY app_name
