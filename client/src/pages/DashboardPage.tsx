import { useEffect, useState } from 'react';
import { ExternalLink, Play, RefreshCw, Settings, Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import {
  Button, Card, CardContent, CardHeader, CardTitle,
} from '@databricks/appkit-ui/react';
import { trpc, type AppInfo } from '../lib/trpc';
import { StrategySheet } from '../components/StrategySheet';

type ScheduleRow = {
  app_name: string; always_on: boolean; idle_threshold_minutes: number;
  force_stop_hour: number; notes: string; updated_at: string;
};

function cleanState(raw: string) {
  return raw.replace('COMPUTESTATE.', '').replace('ApplicationState.', '').replace('AppDeploymentState.', '');
}

// Compute: is the infrastructure running? (drives billing)
function computeBadge(raw: string): { label: string; cls: string } {
  const s = cleanState(raw).toUpperCase();
  if (s === 'ACTIVE')   return { label: 'Running',  cls: 'bg-green-100 text-green-800' };
  if (s === 'STOPPED')  return { label: 'Stopped',  cls: 'bg-gray-100 text-gray-600' };
  if (s === 'STARTING') return { label: 'Starting', cls: 'bg-yellow-100 text-yellow-800' };
  if (s === 'STOPPING') return { label: 'Stopping', cls: 'bg-orange-100 text-orange-700' };
  return { label: s || '—', cls: 'bg-gray-100 text-gray-500' };
}

// App health: is the application itself healthy?
function healthBadge(raw: string): { label: string; cls: string } | null {
  const s = cleanState(raw).toUpperCase();
  if (!s || s === 'UNAVAILABLE' || s === '') return null; // not meaningful when compute is stopped
  if (s === 'RUNNING')   return { label: 'Healthy',   cls: 'bg-green-100 text-green-800' };
  if (s === 'CRASHED')   return { label: 'Crashed',   cls: 'bg-red-100 text-red-700' };
  if (s === 'DEPLOYING') return { label: 'Deploying', cls: 'bg-blue-100 text-blue-700' };
  if (s === 'PAUSED')    return { label: 'Paused',    cls: 'bg-yellow-100 text-yellow-700' };
  return null;
}

function relativeTime(iso: string) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isAlwaysOn(cfg: ScheduleRow) {
  // always_on can arrive as boolean true or string "true" from the warehouse
  return cfg.always_on === true || String(cfg.always_on) === 'true';
}

function configBadges(cfg: ScheduleRow): { label: string; color: string }[] {
  if (isAlwaysOn(cfg)) {
    return [{ label: 'Always on', color: 'bg-green-100 text-green-800' }];
  }
  const badges: { label: string; color: string }[] = [];
  const idle = Number(cfg.idle_threshold_minutes);
  if (idle > 0) {
    badges.push({ label: `Shut down idle ${idle}m`, color: 'bg-blue-100 text-blue-800' });
  }
  const fsh = cfg.force_stop_hour;
  if (fsh != null && fsh !== undefined) {
    badges.push({ label: `Stop at ${String(Number(fsh)).padStart(2, '0')}:00 UTC`, color: 'bg-orange-100 text-orange-800' });
  }
  if (badges.length === 0) {
    badges.push({ label: 'Always on', color: 'bg-green-100 text-green-800' });
  }
  return badges;
}

type StopRow = { app_name: string; stop_count: number };

export function DashboardPage({ schedule, stopsLast24h = [], missingTelemetryCount = 0, missingTelemetryApps = new Set() }: {
  schedule: ScheduleRow[];
  stopsLast24h?: StopRow[];
  missingTelemetryCount?: number;
  missingTelemetryApps?: Set<string>;
}) {
  const [apps, setApps]               = useState<AppInfo[]>([]);
  const [loading, setLoading]         = useState(true);
  const [runningJob, setRunningJob]   = useState(false);
  const [editApp, setEditApp]         = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchApps = async () => {
    setLoading(true);
    try {
      const result = await trpc.listApps.query();
      setApps(result as AppInfo[]);
      setLastRefresh(new Date());
    } catch (e) {
      console.error('Failed to fetch apps', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchApps(); }, []);

  const scheduleMap = Object.fromEntries(schedule.map(s => [s.app_name, s]));
  const stopMap     = Object.fromEntries(stopsLast24h.map(s => [s.app_name, Number(s.stop_count)]));

  const runMonitor = async (dryRun: boolean) => {
    setRunningJob(true);
    try {
      const { runId } = await trpc.runMonitor.mutate({ dryRun });
      alert(`Monitor job triggered (run ID: ${runId}). Check job runs for output.`);
    } catch (e: unknown) {
      alert(`Failed to trigger job: ${(e as Error).message}`);
    } finally {
      setRunningJob(false);
    }
  };

  const editingSchedule = editApp ? scheduleMap[editApp] : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">App Dashboard</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {apps.length} app{apps.length !== 1 ? 's' : ''} · refreshed {lastRefresh.toLocaleTimeString()}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={fetchApps} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => runMonitor(false)} disabled={runningJob}>
            <Play className="h-4 w-4 mr-1.5" />
            {runningJob ? 'Triggering…' : 'Run Monitor Now'}
          </Button>
        </div>
      </div>

      {/* Telemetry missing banner */}
      {missingTelemetryCount > 0 && (
        <div className="flex items-start gap-3 p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-600" />
          <div>
            <span className="font-semibold">{missingTelemetryCount} app{missingTelemetryCount !== 1 ? 's' : ''} missing telemetry</span>
            {' '}— these apps cannot be idle-detected and will not be stopped automatically.
            {' '}<a href="/help" className="underline hover:text-amber-700">Setup guide →</a>
          </div>
        </div>
      )}

      {loading && apps.length === 0 ? (
        <div className="text-center text-muted-foreground py-16">Loading apps…</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {apps.map(app => {
            const cfg = scheduleMap[app.name];
            return (
              <Card key={app.name} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base truncate">{app.name}</CardTitle>
                    {app.url && (
                      <a href={app.url} target="_blank" rel="noreferrer"
                         className="text-xs text-primary flex items-center gap-1 mt-0.5 hover:underline truncate">
                        Open app <ExternalLink className="h-3 w-3 flex-shrink-0" />
                      </a>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-3 text-sm">

                  {/* Compute status — drives billing */}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground text-xs">Compute</span>
                    <div className="flex items-center gap-1.5">
                      {(() => { const b = computeBadge(app.computeState); return (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${b.cls}`}>{b.label}</span>
                      ); })()}
                      {app.computeMessage && (
                        <span className="text-xs text-muted-foreground truncate max-w-[120px]" title={app.computeMessage}>
                          {app.computeMessage}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* App health — is the application itself healthy? */}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground text-xs">Health</span>
                    {(() => {
                      const b = healthBadge(app.appState);
                      return b
                        ? <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${b.cls}`}>{b.label}</span>
                        : <span className="text-xs text-muted-foreground">—</span>;
                    })()}
                  </div>
                  {/* Config badges */}
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-muted-foreground flex-shrink-0 pt-0.5">Config</span>
                    {cfg ? (
                      <div className="flex flex-wrap gap-1 justify-end">
                        {configBadges(cfg).map(b => (
                          <span key={b.label} className={`px-2 py-0.5 rounded-full text-xs font-medium ${b.color}`}>
                            {b.label}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">not registered</span>
                    )}
                  </div>


                  {/* Creator */}
                  {app.creator && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Owner</span>
                      <span className="truncate max-w-[160px]" title={app.creator}>{app.creator}</span>
                    </div>
                  )}

                  {/* Compute message */}
                  {app.computeMessage && (
                    <p className="text-xs text-muted-foreground border-t pt-2">{app.computeMessage}</p>
                  )}

                  {/* Notes */}
                  {cfg?.notes && (
                    <p className="text-xs text-muted-foreground truncate" title={cfg.notes}>
                      {cfg.notes}
                    </p>
                  )}

                  {/* Compact footer: telemetry + stops + update time */}
                  <div className="flex items-center justify-between border-t pt-2 text-xs text-muted-foreground gap-2 flex-wrap">
                    <span className={`flex items-center gap-1 flex-shrink-0 ${
                      missingTelemetryApps.has(app.name)
                        ? 'text-red-600'
                        : app.telemetryEnabled ? 'text-green-600' : 'text-amber-500'
                    }`}>
                      {missingTelemetryApps.has(app.name)
                        ? <><AlertTriangle className="h-3 w-3" /> Missing instrumentation</>
                        : app.telemetryEnabled
                          ? <><Wifi className="h-3 w-3" /> Telemetry on</>
                          : <><WifiOff className="h-3 w-3" /> No telemetry</>}
                    </span>
                    {(stopMap[app.name] ?? 0) > 0 && (
                      <span className="text-orange-600 font-medium flex-shrink-0">
                        stopped {stopMap[app.name]}× (24h)
                      </span>
                    )}
                    {app.updateTime && (
                      <span title={app.updateTime} className="ml-auto flex-shrink-0">
                        {relativeTime(app.updateTime)}
                      </span>
                    )}
                  </div>

                  <Button variant="outline" size="sm" className="w-full mt-2"
                          onClick={() => setEditApp(app.name)}>
                    <Settings className="h-3.5 w-3.5 mr-1.5" /> Edit Strategy
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Strategy edit sheet */}
      {editApp && (
        <StrategySheet
          appName={editApp}
          current={editingSchedule ?? undefined}
          onClose={() => setEditApp(null)}
          onSaved={fetchApps}
        />
      )}
    </div>
  );
}
