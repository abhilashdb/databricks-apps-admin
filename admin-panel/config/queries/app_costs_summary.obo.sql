-- Per-app DBU totals for last 30 days.
-- Cost conversion is applied client-side using config/costs.json.
SELECT
  u.usage_metadata.app_name                               AS app_name,
  ROUND(CAST(SUM(u.usage_quantity) AS DOUBLE), 2)         AS total_dbus,
  ROUND(CAST(AVG(u.usage_quantity) AS DOUBLE), 2)         AS avg_dbus_per_day,
  MIN(CAST(u.usage_date AS STRING))                       AS first_seen,
  MAX(CAST(u.usage_date AS STRING))                       AS last_seen
FROM system.billing.usage u
WHERE u.billing_origin_product = 'APPS'
  AND u.workspace_id = '7474655891769608'
  AND u.usage_date >= CURRENT_DATE - INTERVAL 30 DAYS
  AND u.usage_metadata.app_name IS NOT NULL
GROUP BY u.usage_metadata.app_name
ORDER BY total_dbus DESC
