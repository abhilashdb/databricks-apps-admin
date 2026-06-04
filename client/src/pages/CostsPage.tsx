import { useEffect, useState } from 'react';
import { useAnalyticsQuery, BarChart, DataTable } from '@databricks/appkit-ui/react';
import { DollarSign, Zap, TrendingUp, Settings2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@databricks/appkit-ui/react';
import { trpc, type CostConfig } from '../lib/trpc';

function KpiCard({ title, value, sub, icon: Icon }: {
  title: string; value: string; sub?: string; icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-1">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function fmt(cost: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 })
    .format(cost);
}

export function CostsPage() {
  const [config, setConfig] = useState<CostConfig>({ dbuRate: 0.75, currency: 'USD' });

  useEffect(() => {
    trpc.getConfig.query().then(setConfig).catch(() => {/* use defaults */});
  }, []);

  const { data: summary, loading } = useAnalyticsQuery('app_costs_summary', {});

  const totalDbus = summary?.reduce((s, r) => s + Number(r.total_dbus ?? 0), 0) ?? 0;
  const totalCost = totalDbus * config.dbuRate;
  const topApp    = summary?.[0];

  // Enrich summary with cost column for the chart
  const summaryWithCost = summary?.map(r => ({
    ...r,
    cost: Math.round(Number(r.total_dbus) * config.dbuRate * 100) / 100,
  }));

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Cost Dashboard</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            App compute usage (last 30 days) · source: <code>system.billing.usage</code>
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground border rounded px-2.5 py-1.5">
          <Settings2 className="h-3.5 w-3.5" />
          Rate: <strong>{fmt(config.dbuRate, config.currency)}/DBU</strong>
          <span className="text-muted-foreground/60 ml-1">· edit config/costs.json to change</span>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Total DBUs (30d)"
          value={totalDbus > 0 ? totalDbus.toFixed(1) : loading ? '…' : '—'}
          sub="All apps combined"
          icon={Zap}
        />
        <KpiCard
          title={`Est. Cost (30d)`}
          value={totalCost > 0 ? fmt(totalCost, config.currency) : loading ? '…' : '—'}
          sub={`@ ${fmt(config.dbuRate, config.currency)}/DBU`}
          icon={DollarSign}
        />
        <KpiCard
          title="Top App by DBU"
          value={topApp?.app_name ?? (loading ? '…' : '—')}
          sub={topApp ? `${Number(topApp.total_dbus).toFixed(1)} DBUs` : undefined}
          icon={TrendingUp}
        />
        <KpiCard
          title="Apps with Usage"
          value={loading ? '…' : String(summary?.length ?? 0)}
          sub="in last 30 days"
          icon={Zap}
        />
      </div>

      {/* Cost by app — bar chart */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">
          Estimated Cost by App ({fmt(config.dbuRate, config.currency)}/DBU)
        </h3>
        {summaryWithCost && (
          <BarChart
            data={summaryWithCost}
            xKey="app_name"
            yKey="cost"
            colors={['#6366f1']}
            className="h-64"
          />
        )}
      </div>

      {/* Daily DBU trend */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Daily DBU Consumption</h3>
        <BarChart
          queryKey="app_costs_daily"
          parameters={{}}
          xKey="usage_date"
          yKey="dbus"
          colors={['#3b82f6']}
          className="h-64"
        />
      </div>

      {/* Per-app summary table — transform adds est. cost column */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Per-App Summary</h3>
        <DataTable
          queryKey="app_costs_summary"
          parameters={{}}
          filterColumn="app_name"
          filterPlaceholder="Filter by app…"
          pageSize={20}
          transform={(rows: unknown[]) =>
            (rows as Array<{ total_dbus: number; [k: string]: unknown }>).map(r => ({
              ...r,
              [`est_cost_${config.currency.toLowerCase()}`]:
                fmt(Number(r.total_dbus) * config.dbuRate, config.currency),
            }))
          }
        />
      </div>

      {/* Daily breakdown */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Daily Breakdown</h3>
        <DataTable
          queryKey="app_costs_daily"
          parameters={{}}
          filterColumn="app_name"
          filterPlaceholder="Filter by app…"
          pageSize={25}
        />
      </div>
    </div>
  );
}
