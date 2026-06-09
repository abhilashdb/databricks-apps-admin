import { createApp, analytics, server, getWorkspaceClient } from '@databricks/appkit';
import { WorkspaceClient } from '@databricks/sdk-experimental';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';

const CATALOG = process.env.TELEMETRY_CATALOG ?? 'main';
const SCHEMA  = process.env.TELEMETRY_SCHEMA  ?? 'app_telemetry';
const TABLE   = `${CATALOG}.${SCHEMA}.app_schedule`;

// Derive the client type from getWorkspaceClient to avoid duplicate-package type conflicts
// between the root @databricks/sdk-experimental and the one nested under @databricks/lakebase.
type WsClient = ReturnType<typeof getWorkspaceClient>;

function oboClient(req: Request): WsClient {
  const token = req.headers['x-forwarded-access-token'] as string | undefined;
  if (!token) {
    if (process.env.NODE_ENV === 'development') return getWorkspaceClient({});
    throw new Error('Missing x-forwarded-access-token — cannot execute on behalf of user');
  }
  // authType: 'pat' prevents the SDK from also picking up DATABRICKS_CLIENT_ID/SECRET from env,
  // which would cause "more than one authorization method configured" in the app runtime.
  // Cast needed because new WorkspaceClient() resolves to the root sdk-experimental copy
  // while WsClient comes from the lakebase-nested copy — structurally identical, different identity.
  return new WorkspaceClient({ token, authType: 'pat' }) as unknown as WsClient;
}

async function sqlExecute(client: WsClient, statement: string) {
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) throw new Error('DATABRICKS_WAREHOUSE_ID not set');
  const result = await client.statementExecution.executeStatement({
    warehouse_id: warehouseId,
    statement,
    wait_timeout: '30s',
  });
  if (result.status?.state === 'FAILED') {
    throw new Error(result.status.error?.message ?? 'SQL execution failed');
  }
  return result;
}


createApp({
  plugins: [analytics(), server()],
  cache: { enabled: false },

  async onPluginsReady(appkit) {
    appkit.server.extend((app) => {

      // ── GET /api/admin/config ──────────────────────────────────────────────
      // Serves config/costs.json — edit that file to change the DBU rate.
      app.get('/api/admin/config', (_req, res) => {
        try {
          const raw  = readFileSync(join(process.cwd(), 'config/costs.json'), 'utf8');
          const cfg  = JSON.parse(raw) as { dbuRate: number; currency: string };
          res.json(cfg);
        } catch {
          res.json({ dbuRate: 0.75, currency: 'USD' });  // fallback
        }
      });

      // ── GET /api/admin/apps ─────────────────────────────────────────────────
      // Returns all apps from the Apps API with live status
      app.get('/api/admin/apps', async (_req, res) => {
        try {
          const client = getWorkspaceClient({});
          const result: object[] = [];
          for await (const a of client.apps.list({})) {
            // telemetry_export_destinations is not in the SDK types yet — read safely
          const appRaw = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
          const telemetry = Array.isArray(appRaw['telemetry_export_destinations'])
            && (appRaw['telemetry_export_destinations'] as unknown[]).length > 0;

          // apps.list() often omits app_status — infer from deployment state
          const deployState = a.active_deployment?.status?.state?.toString() ?? '';
          const appState = a.app_status?.state?.toString()
            ?? (deployState === 'SUCCEEDED' ? 'RUNNING'
               : deployState === 'FAILED'   ? 'UNAVAILABLE'
               : deployState);

          result.push({
              name:               a.name,
              url:                a.url ?? '',
              computeState:       a.compute_status?.state?.toString() ?? 'UNKNOWN',
              computeMessage:     a.compute_status?.message ?? '',
              appState,
              appMessage:         a.app_status?.message ?? a.active_deployment?.status?.message ?? '',
              creator:            a.creator ?? '',
              createTime:         a.create_time ?? '',
              updateTime:         a.update_time ?? '',
              description:        a.description ?? '',
              servicePrincipal:   a.service_principal_name ?? '',
              activeDeployment:   a.active_deployment?.deployment_id ?? '',
              telemetryEnabled:   telemetry,
            });
          }
          res.json(result);
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      });

      // ── POST /api/admin/update-strategy ────────────────────────────────────
      app.post('/api/admin/update-strategy', async (req, res) => {
        try {
          const { appName, alwaysOn, idleThresholdMinutes, forceStopHour,
                  notes } = req.body as Record<string, unknown>;

          if (typeof appName !== 'string' || !/^[a-z0-9-]+$/.test(appName))
            throw new Error('Invalid appName');
          if (forceStopHour != null && (typeof forceStopHour !== 'number' || forceStopHour < 0 || forceStopHour > 23))
            throw new Error('force_stop_hour must be 0-23');

          const bool = (v: unknown) => v === true ? 'true' : 'false';
          const str  = (v: unknown) => v && typeof v === 'string' ? `'${(v as string).replace(/'/g, "''")}'` : 'NULL';
          const num  = (v: unknown) => typeof v === 'number' ? v : 'NULL';

          await sqlExecute(oboClient(req), `
            UPDATE ${TABLE}
            SET always_on              = ${bool(alwaysOn)},
                idle_threshold_minutes = ${num(idleThresholdMinutes)},
                force_stop_hour        = ${num(forceStopHour)},
                notes                  = ${str(notes)},
                updated_at             = current_timestamp()
            WHERE app_name = '${appName}'
          `);
          res.json({ success: true });
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      });

    });
  },

}).catch(console.error);
