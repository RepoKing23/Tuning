import { isPlausible } from '../log/channelMeta';
import type { ChannelHealth } from '../log/channelHealth';
import type { LogFile } from '../log/types';
import { clampAndQuantise } from '../rom/readTable';
import type { TableData } from '../rom/readTable';
import { binLog, isOverrunAt, median, OVERRUN_FILTER } from './binning';
import type { CellStats } from './binning';
import { inWindow, MIN_SAMPLES, PROFILES } from './profiles';
import type { OverrunWindow, ProfileId } from './profiles';
import { blocked } from './types';
import type { CellSuggestion, Recommendation } from './types';

/**
 * Overrun fuelling: the half of pops & bangs that the spark map cannot do.
 *
 * Retarding the overrun cells past TDC only makes noise if there is fuel left
 * to burn when the exhaust valve opens. Two things decide that, and both have
 * to be right:
 *
 *  1. Whether the ECU injects at all on a closed throttle. If the decel fuel
 *     cut is active the injectors are shut, the AFR map is never consulted, and
 *     no amount of enrichment or retard makes a sound. The logs show this
 *     directly: injector pulse width reads zero on the lift.
 *  2. How much it injects when it does. A stoichiometric charge burns almost
 *     completely in the cylinder even when lit late; commanding the overrun
 *     cells of the AFR map rich is what sends unburnt fuel into the exhaust.
 *
 * `analyseOverrun` answers the first from the logs. `recommendOverrunAfr`
 * writes the second into the AFR map.
 */

export interface OverrunLogInput {
  log: LogFile;
  health: Map<string, ChannelHealth>;
}

export interface OverrunOptions {
  profile: ProfileId;
  /** Scales the enrichment; 1.0 is the profile's nominal target. */
  intensity: number;
  /** Cells to enrich, in axis units. Defaults to the profile's own window. */
  overrunWindow?: OverrunWindow | null;
  /** Multiplier taking the log's Load into the ROM's Ev%. See detectLoadScale. */
  loadScale?: number;
  /** Overrun samples needed before a cell shared with cruise is enriched. */
  minSamples?: number;
}

/** Stoichiometric petrol, the AFR the enrichment is measured from. */
const STOICH = 14.7;

/** Injector pulse width at or below this, in ms, means the ECU has cut fuel. */
const FUEL_CUT_IPW_MS = 0.1;

/** A wideband reading above this on the overrun is air, not a mixture. */
const LEAN_RAIL_AFR = 20;

/**
 * The AFR the overrun cells are driven to, after intensity.
 *
 * Intensity scales the enrichment rather than the AFR itself, so 0.5 means
 * half as far from stoichiometric, not half the AFR.
 */
export function overrunAfrTarget(profileId: ProfileId, intensity: number): number {
  const p = PROFILES[profileId];
  const target = p.overrunTargetAfr ?? STOICH;
  return STOICH - (STOICH - target) * p.aggression * intensity;
}

export interface OverrunEvidence {
  /** Closed-throttle deceleration samples across all logs. */
  overrunSamples: number;
  /** Of those, how many had a logged injector pulse width. */
  ipwSamples: number;
  /** Of those, how many had the injectors shut — decel fuel cut. */
  fuelCutSamples: number;
  /** Overrun samples whose wideband read air rather than a mixture. */
  widebandLean: number;
  /** Median plausible wideband AFR on the overrun with fuel still flowing. */
  fuelledAfrMedian: number;
  /** Median ECU target AFR on the overrun with fuel still flowing. */
  fuelledTargetMedian: number;
  /** True when the logs show the injectors shut on most lifts. */
  fuelCutBlocking: boolean;
  /** Plain-language findings, most important first. */
  notes: string[];
}

/**
 * What actually happens on a lift-off in these logs.
 *
 * This is the check that explains a tune with the spark and AFR maps already
 * set and still no pops: the fuel cut is shutting the injectors before either
 * map gets a say.
 */
export function analyseOverrun(
  inputs: OverrunLogInput[],
  options: Pick<OverrunOptions, 'profile' | 'intensity'>,
): OverrunEvidence {
  let overrunSamples = 0;
  let ipwSamples = 0;
  let fuelCutSamples = 0;
  let widebandLean = 0;
  const fuelledAfr: number[] = [];
  const fuelledTarget: number[] = [];
  let ipwLogged = false;

  for (const { log, health } of inputs) {
    const ipw = log.byName.get('IPW');
    const wb = health.get('WideBandAF')?.status === 'ok' ? log.byName.get('WideBandAF') : undefined;
    const target = log.byName.get('Target_AFR');
    if (ipw) ipwLogged = true;

    for (let i = 0; i < log.rowCount; i++) {
      if (!isOverrunAt(log, i)) continue;
      overrunSamples++;

      const pw = ipw ? ipw.values[i] : NaN;
      const cut = !Number.isNaN(pw) && pw <= FUEL_CUT_IPW_MS;
      if (!Number.isNaN(pw)) {
        ipwSamples++;
        if (cut) fuelCutSamples++;
      }

      const afr = wb ? wb.values[i] : NaN;
      if (!Number.isNaN(afr) && afr > LEAN_RAIL_AFR) widebandLean++;
      if (cut) continue;
      if (isPlausible('WideBandAF', afr) && afr <= LEAN_RAIL_AFR) fuelledAfr.push(afr);
      const t = target ? target.values[i] : NaN;
      if (isPlausible('Target_AFR', t) && t > 0) fuelledTarget.push(t);
    }
  }

  const notes: string[] = [];
  const want = overrunAfrTarget(options.profile, options.intensity);
  const fuelledAfrMedian = median(fuelledAfr);
  const fuelledTargetMedian = median(fuelledTarget);
  const fuelCutBlocking = ipwSamples > 0 && fuelCutSamples / ipwSamples >= 0.5;
  const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;

  if (overrunSamples === 0) {
    notes.push(
      'Your logs contain no closed-throttle deceleration, so whether the ECU cuts fuel on lift ' +
        'cannot be checked. Log a few lift-offs from 3000-5000 rpm in gear.',
    );
  } else if (!ipwLogged) {
    notes.push(
      'IPW is not logged. Injector pulse width is the only channel that shows whether the ECU ' +
        'is cutting fuel on the overrun — add it before judging whether the AFR changes work.',
    );
  } else if (fuelCutBlocking) {
    notes.push(
      `Injector pulse width was zero in ${pct(fuelCutSamples, ipwSamples)} of the ` +
        `${ipwSamples} logged overrun samples: the decel fuel cut is shutting the injectors on ` +
        'lift. While it does, the AFR map is not consulted and the retarded spark has nothing to ' +
        'light, so neither change makes any noise. Delaying the cut (THROTTLE DECEL and FUEL ' +
        'CUT tables below) is the most important step — this is why the stock map, which already ' +
        'asks for a rich overrun, makes no pops.',
    );
  } else if (ipwSamples > 0) {
    notes.push(
      `Fuel kept flowing in ${pct(ipwSamples - fuelCutSamples, ipwSamples)} of the logged ` +
        'overrun samples, so the AFR map is in control on the lift and the enrichment will take ' +
        'effect.',
    );
  }

  if (fuelledAfr.length >= MIN_SAMPLES) {
    const gap = fuelledAfrMedian - want;
    notes.push(
      `With fuel flowing on the overrun the wideband read a median ${fuelledAfrMedian.toFixed(1)}:1` +
        (fuelledTarget.length ? ` against an ECU target of ${fuelledTargetMedian.toFixed(1)}:1` : '') +
        `; the ${PROFILES[options.profile].label} target is ${want.toFixed(1)}:1. ` +
        (gap > 1
          ? 'Still well lean of it — after applying the AFR changes, re-log and check this again ' +
            'before adding more retard.'
          : gap < -1
            ? 'Already richer than the target; more enrichment would only foul plugs and the cat.'
            : 'Close to the target already.'),
    );
  }

  if (overrunSamples > 0 && widebandLean / overrunSamples >= 0.5) {
    notes.push(
      `The wideband read pure air (above ${LEAN_RAIL_AFR}:1) in ${pct(widebandLean, overrunSamples)} ` +
        'of overrun samples — another sign the injectors are shut on the lift.',
    );
  }

  return {
    overrunSamples,
    ipwSamples,
    fuelCutSamples,
    widebandLean,
    fuelledAfrMedian,
    fuelledTargetMedian,
    fuelCutBlocking,
    notes,
  };
}

function mergeCells(a: CellStats, b: CellStats): CellStats {
  return { n: a.n + b.n, knock: a.knock + b.knock, overrun: a.overrun + b.overrun, values: a.values };
}

/**
 * Enrich the overrun cells of the AFR map for an overrun profile.
 *
 * Like the spark side, this is a configuration choice rather than a correction,
 * so it is not gated on coverage — with one exception that protects cruise. The
 * AFR map is indexed only by rpm and load, so the low-load columns are shared
 * between a closed throttle and a light cruise. The lowest load column in the
 * window is the dedicated overrun column (the stock ROM already asks for ~12.5:1
 * there). Any column above it is enriched only when the logs show it is mostly
 * overrun; otherwise running it rich would run light cruise rich too, costing
 * economy and fouling plugs for no noise.
 *
 * Cells are only ever made richer. A cell already at or beyond the target is
 * left alone.
 */
export function recommendOverrunAfr(
  inputs: OverrunLogInput[],
  table: TableData,
  options: OverrunOptions,
): Recommendation {
  const profile = PROFILES[options.profile];
  if (!profile.overrun) {
    return blocked(`${profile.label} does not change overrun fuelling.`);
  }
  if (table.def.dims !== '3D' || table.nx < 2 || table.ny < 2) {
    return blocked(`${table.def.name} is not a 3D AFR map.`);
  }

  const window = options.overrunWindow ?? profile.defaultWindow!;
  const minSamples = options.minSamples ?? MIN_SAMPLES;
  const rpmAxis = table.y.values;
  const loadAxis = table.x.values;

  let merged: CellStats[][] | null = null;
  for (const { log, health } of inputs) {
    const binned = binLog(log, {
      xAxis: loadAxis,
      yAxis: rpmAxis,
      xChannel: 'Load',
      yChannel: 'RPM',
      collect: [],
      filter: OVERRUN_FILTER,
      ignoreCoolant: health.get('Cooltemp')?.status !== 'ok',
      xScale: options.loadScale ?? 1,
    });
    merged = merged
      ? merged.map((row, r) => row.map((cell, c) => mergeCells(cell, binned.cells[r][c])))
      : binned.cells;
  }

  const windowCols = loadAxis
    .map((load, c) => ({ load, c }))
    .filter(({ load }) => load >= window.loadMin && load <= window.loadMax)
    .map(({ c }) => c);
  if (windowCols.length === 0) {
    return blocked(
      `The overrun window (${window.loadMin}-${window.loadMax} Ev%) contains no load column ` +
        `of ${table.def.name}. Widen the window's load range.`,
    );
  }
  const overrunCol = Math.min(...windowCols);

  const target = overrunAfrTarget(options.profile, options.intensity);
  const suggestions = new Map<string, CellSuggestion>();
  let skipped = 0;
  let alreadyRich = 0;
  let sharedWithCruise = 0;
  let confirmed = 0;

  for (let r = 0; r < rpmAxis.length; r++) {
    for (let c = 0; c < loadAxis.length; c++) {
      const rpm = rpmAxis[r];
      const load = loadAxis[c];
      if (!inWindow(window, rpm, load)) continue;

      const cell = merged?.[r][c] ?? { n: 0, overrun: 0, knock: 0, values: new Map() };
      const driven = cell.n - cell.overrun;
      const current = table.values[r][c];

      if (c !== overrunCol) {
        const mostlyOverrun = cell.overrun >= minSamples && cell.overrun >= driven;
        if (!mostlyOverrun) { sharedWithCruise++; skipped++; continue; }
      }

      if (current <= target + 0.05) { alreadyRich++; skipped++; continue; }

      const value = clampAndQuantise(table.scaling, target, table.values);
      if (!(value < current)) { alreadyRich++; skipped++; continue; }

      if (cell.overrun > 0) confirmed++;
      suggestions.set(`${r},${c}`, {
        value,
        delta: value - current,
        confidence: cell.overrun > 0 ? 1 : 0.6,
        samples: cell.n,
        knock: cell.knock,
        reason:
          `overrun cell: ${current.toFixed(1)} to ${value.toFixed(1)} AFR so unburnt fuel reaches ` +
          'the exhaust, where the retarded spark lights it. ' +
          (cell.overrun > 0
            ? `${cell.overrun} of ${cell.n} samples here were closed-throttle deceleration` +
              (c !== overrunCol ? ', more than the driven samples, so cruise is not affected.' : '.')
            : 'Your logs contain no closed-throttle deceleration in this cell, so this comes ' +
              'from the map region rather than from measurement.'),
      });
    }
  }

  const notes: string[] = [];
  notes.push(
    `Overrun cells are enriched to ${target.toFixed(1)}:1 (stoichiometric is ${STOICH}). Spark ` +
      'retard only makes noise if there is fuel left to burn in the exhaust.',
  );
  notes.push(
    `The ${loadAxis[overrunCol]} Ev% column is treated as the overrun column. ` +
      (sharedWithCruise > 0
        ? `${sharedWithCruise} cell(s) in higher load columns were left alone: they are shared ` +
          'with light cruise and your logs do not show them as mostly overrun, so enriching them ' +
          'would run cruise rich.'
        : 'No higher column needed protecting.'),
  );
  if (alreadyRich > 0) {
    notes.push(`${alreadyRich} cell(s) were already at or richer than the target and were left alone.`);
  }
  notes.push(
    `Your logs confirm closed-throttle deceleration in ${confirmed} of the changed cells.`,
  );

  return {
    status: 'ok',
    message:
      `${suggestions.size} AFR cell(s) enriched toward ${target.toFixed(1)}:1 under the ` +
      `${profile.label} profile.`,
    suggestions,
    notes,
    skipped,
    starved: 0,
  };
}
