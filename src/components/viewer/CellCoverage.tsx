import { useMemo } from 'react';
import type { LogFile } from '../../lib/log/types';
import { binLog, cellStat, DEFAULT_FILTER, OVERRUN_FILTER } from '../../lib/tune/binning';
import type { SampleFilter } from '../../lib/tune/binning';
import { heatColor } from '../../lib/log/palette';

export type CoverageMode = 'count' | 'mean' | 'median' | 'max' | 'knock';

export interface CellCoverageProps {
  logs: LogFile[];
  /** Display-scale axes of the table this grid mirrors. */
  xAxis: number[];
  yAxis: number[];
  xLabel: string;
  yLabel: string;
  xChannel: string;
  yChannel: string;
  mode: CoverageMode;
  /** Channel summarised when mode is mean/median/max. */
  statChannel: string;
  timeRange?: [number, number] | null;
  filter?: SampleFilter;
  ignoreCoolant?: boolean;
  /** Multiplier taking the log's X channel into the ROM axis's units. */
  xScale?: number;
}

/**
 * The same RPM x Load space as a tuning table, filled with what the logs
 * actually recorded there.
 *
 * Cell counts are the honest prerequisite for changing anything: a cell with
 * four samples in it does not justify a timing change, however confident an
 * average looks.
 */
export function CellCoverage({
  logs, xAxis, yAxis, xLabel, yLabel, xChannel, yChannel,
  mode, statChannel, timeRange, filter, ignoreCoolant, xScale = 1,
}: CellCoverageProps) {
  const { grid, maxValue, minValue, totalUsed, rejected } = useMemo(() => {
    const effectiveFilter = filter ?? (mode === 'knock' ? OVERRUN_FILTER : DEFAULT_FILTER);
    const acc: { n: number; stat: number[]; knock: number }[][] = yAxis.map(() =>
      xAxis.map(() => ({ n: 0, stat: [], knock: 0 })),
    );
    let used = 0;
    const rej: Record<string, number> = {};

    for (const log of logs) {
      const binned = binLog(log, {
        xAxis, yAxis, xChannel, yChannel,
        collect: statChannel ? [statChannel] : [],
        filter: effectiveFilter,
        timeRange,
        ignoreCoolant,
        xScale,
      });
      used += binned.used;
      for (const [why, n] of Object.entries(binned.rejected)) rej[why] = (rej[why] ?? 0) + n;
      for (let r = 0; r < yAxis.length; r++) {
        for (let c = 0; c < xAxis.length; c++) {
          const cell = binned.cells[r][c];
          acc[r][c].n += cell.n;
          acc[r][c].knock += cell.knock;
          const arr = cell.values.get(statChannel);
          if (arr) acc[r][c].stat.push(...arr);
        }
      }
    }

    let lo = Infinity;
    let hi = -Infinity;
    const g = acc.map((row) =>
      row.map((cell) => {
        let v: number;
        if (mode === 'count') v = cell.n;
        else if (mode === 'knock') v = cell.knock;
        else v = cellStat(
          { n: cell.n, values: new Map([[statChannel, cell.stat]]), knock: cell.knock, overrun: 0 },
          statChannel,
          mode,
        );
        if (Number.isFinite(v) && (mode !== 'count' || v > 0)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        return { value: v, n: cell.n };
      }),
    );

    return { grid: g, maxValue: hi, minValue: lo, totalUsed: used, rejected: rej };
  }, [logs, xAxis, yAxis, xChannel, yChannel, mode, statChannel, timeRange, filter, ignoreCoolant, xScale]);

  const span = maxValue - minValue;
  const label =
    mode === 'count' ? 'samples'
    : mode === 'knock' ? 'knock counts'
    : `${mode} ${statChannel}`;

  const topRejections = Object.entries(rejected)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  return (
    <div>
      <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="muted">
          {label} · {totalUsed.toLocaleString()} samples binned
        </span>
        <span className="legend-scale">
          {Number.isFinite(minValue) ? minValue.toFixed(mode === 'count' || mode === 'knock' ? 0 : 1) : '—'}
          <span className="bar" />
          {Number.isFinite(maxValue) ? maxValue.toFixed(mode === 'count' || mode === 'knock' ? 0 : 1) : '—'}
        </span>
      </div>

      <div className="grid-scroll">
        <table className="tune">
          <thead>
            <tr>
              <th>{yLabel} \ {xLabel}</th>
              {xAxis.map((x, i) => <th key={i}>{Math.round(x)}</th>)}
            </tr>
          </thead>
          <tbody>
            {yAxis.map((y, r) => (
              <tr key={r}>
                <th>{Math.round(y)}</th>
                {xAxis.map((_, c) => {
                  const cell = grid[r][c];
                  const empty = mode === 'count' ? cell.value === 0 : !Number.isFinite(cell.value);
                  const t = span > 0 ? (cell.value - minValue) / span : 0.5;
                  return (
                    <td
                      key={c}
                      title={`${yLabel} ${Math.round(y)} · ${xLabel} ${Math.round(xAxis[c])}\n` +
                             `${cell.n} samples`}
                      style={{
                        background: empty ? '#171b21' : heatColor(t),
                        color: empty ? '#4a525e' : '#0d1117',
                      }}
                    >
                      {empty ? '·' : mode === 'count' || mode === 'knock'
                        ? cell.value.toFixed(0)
                        : cell.value.toFixed(1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {topRejections.length > 0 && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Filtered out: {topRejections.map(([why, n]) => `${n.toLocaleString()} ${why}`).join(' · ')}
        </div>
      )}
    </div>
  );
}
