// Typed REST client for the admin Express API endpoints.

const BASE = '/api/admin';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res  = await fetch(`${BASE}/${path}`, opts);
  const data = await res.json() as T & { error?: string };
  if (!res.ok || (data as { error?: string }).error) {
    throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return data;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export type AppInfo = {
  name: string; url: string; computeState: string; computeMessage: string;
  appState: string; appMessage: string; creator: string; createTime: string;
  updateTime: string; description: string; servicePrincipal: string;
  activeDeployment: string; telemetryEnabled: boolean;
};

export type UpdateStrategyInput = {
  appName: string;
  alwaysOn: boolean;
  idleThresholdMinutes?: number | null;
  forceStopHour?: number | null;
  notes?: string | null;
};

export type CostConfig = { dbuRate: number; currency: string };

export const trpc = {
  getConfig: {
    query: () => apiFetch<CostConfig>('config'),
  },
  listApps: {
    query: () => apiFetch<AppInfo[]>('apps'),
  },
  updateStrategy: {
    mutate: (input: UpdateStrategyInput) =>
      post<{ success: boolean }>('update-strategy', input),
  },
};
