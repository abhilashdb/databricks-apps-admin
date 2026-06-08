import { BarChart, DataTable } from '@databricks/appkit-ui/react';

export function EventsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Events Log</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Audit trail of every idle assessment and action taken by the monitor
        </p>
      </div>

      {/* Events by action — bar chart (last 7 days) */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Events by Action (last 7 days)</h3>
        <BarChart
          queryKey="events_by_action"
          parameters={{}}
          xKey="action"
          yKey="event_count"
          colors={['#3b82f6']}
          className="h-64"
        />
      </div>

      {/* Full event log — auto-generated columns */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Recent Events (last 200)</h3>
        <DataTable
          queryKey="recent_events"
          parameters={{}}
          filterColumn="app_name"
          filterPlaceholder="Filter by app name…"
          pageSize={25}
        />
      </div>
    </div>
  );
}
