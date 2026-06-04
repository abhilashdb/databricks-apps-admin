import { useState } from 'react';
import {
  Button, Input,
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@databricks/appkit-ui/react';
import { trpc, type UpdateStrategyInput } from '../lib/trpc';

type ScheduleRow = {
  app_name: string; always_on: boolean; idle_threshold_minutes: number;
  force_stop_hour: number; notes: string; updated_at: string;
};

type Props = {
  appName: string;
  current?: ScheduleRow;
  onClose: () => void;
  onSaved: () => void;
};

export function StrategySheet({ appName, current, onClose, onSaved }: Props) {
  const [alwaysOn,   setAlwaysOn]   = useState(
    current?.always_on === true || String(current?.always_on) === 'true'
  );
  const [threshold,  setThreshold]  = useState((current?.idle_threshold_minutes ?? 30).toString());
  const [forceHour,  setForceHour]  = useState((current?.force_stop_hour ?? 22).toString());
  const [notes,      setNotes]      = useState(current?.notes ?? '');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const input: UpdateStrategyInput = {
        appName,
        alwaysOn,
        idleThresholdMinutes: alwaysOn ? null : parseInt(threshold),
        forceStopHour:        alwaysOn ? null : (forceHour !== '' ? parseInt(forceHour) : null),
        notes: notes || null,
      };
      await trpc.updateStrategy.mutate(input);
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-[400px] sm:w-[440px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Edit Config — {appName}</SheetTitle>
        </SheetHeader>

        <div className="space-y-5 mt-6">

          {/* Exception flag */}
          <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30">
            <input
              type="checkbox"
              id="alwaysOn"
              checked={alwaysOn}
              onChange={e => setAlwaysOn(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded"
            />
            <div>
              <label htmlFor="alwaysOn" className="text-sm font-medium cursor-pointer">
                Always on (exception)
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Never stop this app automatically. Overrides idle and force-stop settings.
              </p>
            </div>
          </div>

          {!alwaysOn && (
            <>
              {/* Force stop hour */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Force stop at (UTC hour)</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={forceHour}
                    onChange={e => setForceHour(e.target.value)}
                    className="w-24"
                    placeholder="22"
                  />
                  <span className="text-sm text-muted-foreground">
                    {forceHour !== '' ? `= ${forceHour}:00 UTC daily` : '(disabled)'}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  App is force-stopped at this UTC hour every day. Leave blank to disable.
                </p>
              </div>

              {/* Idle threshold */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Shut down if idle (minutes)</label>
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  value={threshold}
                  onChange={e => setThreshold(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Stop early if no traffic for this many minutes. Framework (Dash/Flask vs Streamlit) is detected automatically from telemetry.
                </p>
              </div>
            </>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Notes (optional)</label>
            <Input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Finance team dashboard, prod"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2 pt-2">
            <Button onClick={save} disabled={saving} className="flex-1">
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
