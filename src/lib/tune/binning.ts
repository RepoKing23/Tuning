import type { LogChannel, LogFile } from '../log/types';

/**
 * Attribution of log samples to table cells, plus the sample filters that make
 * that attribution meaningful.
 *
 * A cell only deserves a change if the engine actually spent settled time in it.
 * Samples taken mid-transient say more about the accelerator pump and the
 * sensor's own lag than about the cell you are pointing at, so they are
 * excluded rather than averaged in.
 */

export interface SampleFilter {
  /** Reject samples where |dRPM/dt| exceeds this, in rpm per second. */
  maxRpmRate: number;
  /** Reject samples where |dTPS/dt| exceeds this, in percent per second. */
  maxTpsRate: number;
  /** Reject samples below this coolant temperature. Ignored if ECT is unhealthy. */
  minCoolant: number;
  /** Reject this many samples after any transient, to let sensors settle. */
  settleSamples: number;
  /** Reject closed-throttle overrun (deceleration fuel cut) samples. */
  excludeOverrun: boolean;
  /** Reject samples below this RPM (engine not really running). */
  minRpm: number;
}

export const DEFAULT_FILTER: SampleFilter = {
  maxRpmRate: 600,
  maxTpsRate: 25,
  minCoolant: 70,
  settleSamples: 3,
  excludeOverrun: true,
  minRpm: 500,
};

/** A filter tuned for finding overrun cells rather than avoiding them. */
export const OVERRUN_FILTER: SampleFilter = {
  ...DEFAULT_FILTER,
  maxRpmRate: Infinity,
  maxTpsRate: Infinity,
  excludeOverrun: false,
  settleSamples: 0,
};

export interface CellStats {
  /** Samples that landed in this cell after filtering. */
  n: number;
  /** Per-channel aggregates, keyed by channel name. */
  values: Map<string, number[]>;
  /** Total knock counts observed while in this cell. */
  knock: number;
  /**
   * Of `n`, how many were genuine closed-throttle overrun.
   *
   * The spark map is indexed only by RPM and load, so the low-load columns are
   * shared between true overrun and light cruise. Counting them separately is
   * what lets a profile retard the decel cells without wrecking cruise.
   */
  overrun: number;
}

export interface BinnedTable {
  /** Cell stats indexed [row = y][col = x], matching table display order. */
  cells: CellStats[][];
  /** Samples that passed the filter and landed somewhere. */
  used: number;
  /** Samples rejected, by reason. */
  rejected: Record<string, number>;
}

/** Index of the axis point nearest to a value. */
export function nearestIndex(axis: number[], value: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i] - value);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function rateOfChange(values: Float64Array, time: Float64Array, i: number): number {
  if (i === 0 || i >= values.length) return 0;
  const dt = time[i] - time[i - 1];
  if (!(dt > 0)) return 0;
  const dv = values[i] - values[i - 1];
  if (Number.isNaN(dv)) return 0;
  return dv / dt;
}

export interface BinOptions {
  /** Display-scale X axis values of the target table (usually Load). */
  xAxis: number[];
  /** Display-scale Y axis values of the target table (usually RPM). */
  yAxis: number[];
  /** Log channel supplying the X coordinate. */
  xChannel: string;
  /** Log channel supplying the Y coordinate. */
  yChannel: string;
  /** Channels to collect per cell for later statistics. */
  collect: string[];
  filter: SampleFilter;
  /** Restrict to a time window (seconds from log start). */
  timeRange?: [number, number] | null;
  /** Skip the coolant filter when the ECT channel is known to be unreliable. */
  ignoreCoolant?: boolean;
  /**
   * Multiplier taking the log's X channel into the ROM axis's units. Needed when
   * the logger profile and the definition disagree about load scaling — see
   * `detectLoadScale`. Without it, full-throttle samples bin as cruise.
   */
  xScale?: number;
  /** Same for the Y channel. */
  yScale?: number;
}

export function binLog(log: LogFile, opts: BinOptions): BinnedTable {
  const { xAxis, yAxis, filter } = opts;
  const cells: CellStats[][] = [];
  for (let r = 0; r < yAxis.length; r++) {
    const row: CellStats[] = [];
    for (let c = 0; c < xAxis.length; c++) {
      row.push({ n: 0, values: new Map(), knock: 0, overrun: 0 });
    }
    cells.push(row);
  }

  const xCh = log.byName.get(opts.xChannel);
  const yCh = log.byName.get(opts.yChannel);
  const rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };

  if (!xCh || !yCh) {
    reject(`missing channel ${!xCh ? opts.xChannel : opts.yChannel}`);
    return { cells, used: 0, rejected };
  }

  const rpm = log.byName.get('RPM');
  const tps = log.byName.get('TPS');
  const ect = log.byName.get('Cooltemp');
  const knockSum = log.byName.get('KnockSum');
  const collected: [string, LogChannel][] = [];
  for (const name of opts.collect) {
    const ch = log.byName.get(name);
    if (ch) collected.push([name, ch]);
  }

  let settleUntil = -1;
  let used = 0;

  for (let i = 0; i < log.rowCount; i++) {
    if (opts.timeRange) {
      const t = log.time[i];
      if (t < opts.timeRange[0] || t > opts.timeRange[1]) { reject('outside time window'); continue; }
    }

    const rpmRate = rpm ? Math.abs(rateOfChange(rpm.values, log.time, i)) : 0;
    const tpsRate = tps ? Math.abs(rateOfChange(tps.values, log.time, i)) : 0;
    if (rpmRate > filter.maxRpmRate || tpsRate > filter.maxTpsRate) {
      settleUntil = i + filter.settleSamples;
      reject('transient');
      continue;
    }
    if (i <= settleUntil) { reject('settling after transient'); continue; }

    if (rpm && !Number.isNaN(rpm.values[i]) && rpm.values[i] < filter.minRpm) {
      reject('engine not running');
      continue;
    }

    if (!opts.ignoreCoolant && ect) {
      const t = ect.values[i];
      if (!Number.isNaN(t) && t < filter.minCoolant) { reject('engine not warm'); continue; }
    }

    // Overrun: closed throttle with the engine being driven by the wheels.
    // Always evaluated, so the count survives even when the filter keeps these
    // samples rather than rejecting them.
    let isOverrun = false;
    if (tps && rpm) {
      const closed = tps.values[i] <= tps.min + 2;
      const decelerating = rateOfChange(rpm.values, log.time, i) < -50;
      isOverrun = closed && decelerating;
    }
    if (filter.excludeOverrun && isOverrun) { reject('overrun / decel fuel cut'); continue; }

    const xv = xCh.values[i] * (opts.xScale ?? 1);
    const yv = yCh.values[i] * (opts.yScale ?? 1);
    if (Number.isNaN(xv) || Number.isNaN(yv)) { reject('no position'); continue; }

    const col = nearestIndex(xAxis, xv);
    const row = nearestIndex(yAxis, yv);
    const cell = cells[row][col];
    cell.n++;
    if (isOverrun) cell.overrun++;
    used++;

    for (const [name, ch] of collected) {
      const v = ch.values[i];
      if (Number.isNaN(v)) continue;
      let arr = cell.values.get(name);
      if (!arr) { arr = []; cell.values.set(name, arr); }
      arr.push(v);
    }

    if (knockSum) {
      const prev = i > 0 ? knockSum.values[i - 1] : NaN;
      const cur = knockSum.values[i];
      if (!Number.isNaN(cur) && !Number.isNaN(prev) && cur > prev) cell.knock += cur - prev;
      else if (!Number.isNaN(cur) && Number.isNaN(prev) && cur > 0) cell.knock += cur;
    }
  }

  return { cells, used, rejected };
}

// --- statistics -------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Interquartile range — a spread measure that ignores the odd wild sample. */
export function iqr(values: number[]): number {
  if (values.length < 4) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return q(0.75) - q(0.25);
}

export function cellStat(cell: CellStats, channel: string, stat: 'mean' | 'median' | 'max' | 'min'): number {
  const arr = cell.values.get(channel);
  if (!arr || arr.length === 0) return NaN;
  switch (stat) {
    case 'mean': return mean(arr);
    case 'median': return median(arr);
    case 'max': return Math.max(...arr);
    case 'min': return Math.min(...arr);
  }
}
