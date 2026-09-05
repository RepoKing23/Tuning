import type { OverrunWindow } from '../../lib/tune/profiles';
import { inWindow } from '../../lib/tune/profiles';

export interface OverrunWindowPickerProps {
  /** Real RPM axis of the loaded spark map. */
  rpmAxis: number[];
  /** Real load axis of the loaded spark map. */
  loadAxis: number[];
  value: OverrunWindow;
  onChange(next: OverrunWindow): void;
  onReset(): void;
  /** Sample counts per cell, so the picker can say what the logs back up. */
  coverage?: number[][];
}

/**
 * Picks the block of cells an overrun profile retards.
 *
 * The bounds are chosen from the table's own breakpoints rather than typed
 * freely, so a window always lands on whole cells — picking 1600 rpm on a map
 * whose axis steps 1500, 1750 would be a bound that means nothing.
 */
export function OverrunWindowPicker({
  rpmAxis, loadAxis, value, onChange, onReset, coverage,
}: OverrunWindowPickerProps) {
  // Keep the pair ordered: moving one end past the other would select nothing.
  const set = (patch: Partial<OverrunWindow>) => {
    const next = { ...value, ...patch };
    if (next.rpmMin > next.rpmMax) {
      if (patch.rpmMin !== undefined) next.rpmMax = next.rpmMin;
      else next.rpmMin = next.rpmMax;
    }
    if (next.loadMin > next.loadMax) {
      if (patch.loadMin !== undefined) next.loadMax = next.loadMin;
      else next.loadMin = next.loadMax;
    }
    onChange(next);
  };

  // "Visited" is deliberately distinct from the engine's decel-confirmed count:
  // a cell can be well sampled in cruise and never once on a closed throttle.
  let cells = 0;
  let visited = 0;
  for (let r = 0; r < rpmAxis.length; r++) {
    for (let c = 0; c < loadAxis.length; c++) {
      if (!inWindow(value, rpmAxis[r], loadAxis[c])) continue;
      cells++;
      if ((coverage?.[r]?.[c] ?? 0) > 0) visited++;
    }
  }

  const axisSelect = (
    axis: number[],
    current: number,
    onPick: (v: number) => void,
    unit: string,
  ) => (
    <select
      value={current}
      onChange={(e) => onPick(Number(e.target.value))}
      style={{ flex: 1, minWidth: 0 }}
    >
      {axis.map((v) => (
        <option key={v} value={v}>
          {Math.round(v)} {unit}
        </option>
      ))}
    </select>
  );

  return (
    <div style={{ marginTop: 10 }}>
      <div className="group-title" style={{ marginTop: 0 }}>Overrun window</div>

      <label className="small muted" style={{ display: 'block', marginBottom: 2 }}>RPM</label>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        {axisSelect(rpmAxis, value.rpmMin, (v) => set({ rpmMin: v }), 'rpm')}
        <span className="muted small">to</span>
        {axisSelect(rpmAxis, value.rpmMax, (v) => set({ rpmMax: v }), 'rpm')}
      </div>

      <label className="small muted" style={{ display: 'block', marginBottom: 2 }}>Load</label>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        {axisSelect(loadAxis, value.loadMin, (v) => set({ loadMin: v }), 'Ev%')}
        <span className="muted small">to</span>
        {axisSelect(loadAxis, value.loadMax, (v) => set({ loadMax: v }), 'Ev%')}
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">
          {cells} cell{cells === 1 ? '' : 's'} selected
          {coverage ? ` · ${visited} visited in your logs` : ''}
        </span>
        <button className="small" onClick={onReset}>Reset</button>
      </div>

      {value.rpmMin < 1250 && (
        <div className="notice bad" style={{ marginTop: 8 }}>
          Including idle rpm. Retarding idle cells past TDC makes the engine stall and
          the idle control fight it. Start the window above where the engine idles.
        </div>
      )}
      {value.loadMax > 60 && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          Including cells above 60 Ev%. Those are under real throttle, not overrun. Retarding
          them past TDC throws most of the combustion heat into the exhaust — it will cost a
          lot of power and can cook the manifold and turbine.
        </div>
      )}
      {cells === 0 && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          This window selects no cells, so nothing will change.
        </div>
      )}
    </div>
  );
}
