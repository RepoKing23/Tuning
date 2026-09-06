import { isPlausible } from '../log/channelMeta';
import type { ChannelHealth } from '../log/channelHealth';
import type { LogFile } from '../log/types';
import { clampAndQuantise } from '../rom/readTable';
import type { TableData } from '../rom/readTable';
import { median, nearestIndex } from './binning';
import { CLOSED_LOOP_TARGET_AFR } from './maf';
import { MIN_SAMPLES, SATURATION_SAMPLES } from './profiles';
import { blocked } from './types';
import type { CellSuggestion, Recommendation } from './types';

/**
 * Where AFR error comes from, and therefore which table fixes it.
 *
 * "3% lean" is not one fault. It can be a wrong MAF transfer, a wrong fuel map,
 * or wrong injectors, and those are three different tables. Handing over a
 * correction grid without saying which one is being blamed leaves the tuner to
 * guess, and guessing wrong means correcting the airflow measurement to paper
 * over a fuelling problem — which then throws off every other load-based
 * calculation the ECU makes.
 *
 * So the error is decomposed in stages, each attributed to one table, and each
 * stage works on what the previous stage left behind. Load and airflow are
 * strongly correlated on a naturally aspirated engine, so without subtracting as
 * we go, both tables would claim the same error and the sum would over-correct.
 */

export type AfrCauseId = 'maf' | 'fuelMap' | 'global';

export interface AfrCause {
  id: AfrCauseId;
  label: string;
  /** Magnitude of the error this cause accounts for, in percent. */
  magnitudePct: number;
  /** Name of the ROM table that fixes it, or null when no table can. */
  table: string | null;
  explanation: string;
}

export interface AfrAnalysis {
  status: 'ok' | 'blocked';
  message: string;
  notes: string[];
  /** Median error in closed loop, reported but never tuned on. */
  closedLoopMedianPct: number;
  closedLoopSamples: number;
  /** Median error in open loop. This is the number that means something. */
  openLoopMedianPct: number;
  openLoopSamples: number;
  /** Ranked, largest first. */
  causes: AfrCause[];
  /** Highest load reached in open loop, so coverage gaps are visible. */
  openLoopMaxLoad: number;
}

export interface AfrLogInput {
  log: LogFile;
  health: Map<string, ChannelHealth>;
}

export interface AfrOptions {
  minSamples: number;
  /** Largest change written into the fuel map in one pass, in percent. */
  maxFuelChangePct: number;
  /** Multiplier taking the log's Load into the ROM's Ev%. See detectLoadScale. */
  loadScale?: number;
}

export const DEFAULT_AFR_OPTIONS: AfrOptions = {
  minSamples: MIN_SAMPLES,
  maxFuelChangePct: 5,
};

/** Error beyond this is enrichment transients or a sensor artefact. */
const MAX_CREDIBLE_ERROR_PCT = 40;
/** Below this the cause is noise, not a finding worth naming. */
const NEGLIGIBLE_PCT = 0.5;

interface Sample {
  errorPct: number;
  volts: number;
  rpm: number;
  load: number;
}

/**
 * A narrowband converted to an AFR-looking number cannot hold a steady rich
 * value: it switches around stoich and its excursions are brief. Tuning on one
 * would be tuning on fiction, so the shape is checked before anything else.
 */
function looksLikeNarrowband(samples: Sample[], rich: number[]): boolean {
  if (rich.length < 30) return false;
  // A real wideband spends meaningful time settled away from stoich.
  const settled = rich.filter((afr) => afr < 13.5).length;
  return settled / rich.length < 0.05 && samples.length > 100;
}

function collect(inputs: AfrLogInput[], loadScale = 1) {
  const open: Sample[] = [];
  const closed: number[] = [];
  const richReadings: number[] = [];
  let railed = 0;
  let rejected = 0;

  for (const { log } of inputs) {
    const wb = log.byName.get('WideBandAF');
    const target = log.byName.get('Target_AFR');
    const maf = log.byName.get('MAF_Voltage');
    const rpm = log.byName.get('RPM');
    const load = log.byName.get('Load');
    if (!wb || !target) continue;

    for (let i = 0; i < log.rowCount; i++) {
      const measured = wb.values[i];
      const want = target.values[i];
      if (!isPlausible('WideBandAF', measured) || !isPlausible('Target_AFR', want) || want <= 0) {
        railed++;
        continue;
      }
      richReadings.push(measured);

      // Lean of target is a positive error, matching the fuel-trim convention:
      // positive means the engine wants more fuel than it is getting.
      const errorPct = (measured / want - 1) * 100;
      if (Math.abs(errorPct) > MAX_CREDIBLE_ERROR_PCT) { rejected++; continue; }

      if (want >= CLOSED_LOOP_TARGET_AFR) { closed.push(errorPct); continue; }

      const v = maf ? maf.values[i] : NaN;
      const r = rpm ? rpm.values[i] : NaN;
      const l = load ? load.values[i] : NaN;
      if (Number.isNaN(v) || Number.isNaN(r) || Number.isNaN(l)) { rejected++; continue; }
      open.push({ errorPct, volts: v, rpm: r, load: l * loadScale });
    }
  }
  return { open, closed, richReadings, railed, rejected };
}

/**
 * Diagnose where the fuelling error lives.
 *
 * `mafTables` are the MAF parts and `fuelTable` the fuel multiplier map; both
 * supply the axes the error is binned onto, so the analysis always speaks in the
 * ROM's own breakpoints rather than invented ones.
 */
export function analyseAfr(
  inputs: AfrLogInput[],
  mafTables: TableData[],
  fuelTable: TableData | null,
  options: AfrOptions = DEFAULT_AFR_OPTIONS,
): AfrAnalysis {
  const empty = {
    closedLoopMedianPct: NaN, closedLoopSamples: 0,
    openLoopMedianPct: NaN, openLoopSamples: 0,
    causes: [], openLoopMaxLoad: NaN,
  };

  if (inputs.length === 0) return { ...blocked('No logs selected.'), ...empty };

  const { open, closed, richReadings, railed, rejected } = collect(inputs, options.loadScale ?? 1);
  const notes: string[] = [];

  if (open.length === 0 && closed.length === 0) {
    return {
      ...blocked(
        'No usable AFR samples. This needs WideBandAF and Target_AFR logged together, with ' +
          'readings inside a believable 8-22 AFR range.',
      ),
      ...empty,
    };
  }

  if (looksLikeNarrowband(open, richReadings)) {
    return {
      ...blocked(
        'This AFR trace looks like a narrowband sensor converted to AFR, not a wideband: it ' +
          'never settles rich. A narrowband is only accurate at stoich, so its readings away ' +
          'from 14.7 are not measurements and tuning on them would be tuning on fiction.',
      ),
      ...empty,
    };
  }

  const closedMedian = closed.length ? median(closed) : NaN;
  const openMedian = open.length ? median(open.map((s) => s.errorPct)) : NaN;

  if (closed.length) {
    notes.push(
      `${closed.length.toLocaleString()} closed-loop samples sit at ${closedMedian.toFixed(2)}% ` +
        'error. That is expected and is not a finding: O2 feedback holds AFR on target there ' +
        'no matter how wrong the MAF is, so it measures the feedback loop rather than the ' +
        'calibration. Only the open-loop samples below are evidence.',
    );
  }

  if (open.length < options.minSamples) {
    return {
      ...blocked(
        `Only ${open.length} open-loop samples. Fuelling error can only be measured where the ` +
          'ECU is commanding enrichment rather than correcting to stoich, so this needs a log ' +
          'with part- or full-throttle pulls in it.',
        notes,
      ),
      closedLoopMedianPct: closedMedian,
      closedLoopSamples: closed.length,
      openLoopMedianPct: openMedian,
      openLoopSamples: open.length,
      causes: [],
      openLoopMaxLoad: open.length ? Math.max(...open.map((s) => s.load)) : NaN,
    };
  }

  // --- stage 1: the component that tracks airflow -------------------------

  // Bin against every MAF part at once, so a sample lands on the part that
  // actually covers its voltage rather than being clamped onto a neighbour.
  const voltAxis = mafTables.flatMap((t) => t.y.values).sort((a, b) => a - b);
  const mafBins = new Map<number, number[]>();
  for (const s of open) {
    const idx = voltAxis.length ? nearestIndex(voltAxis, s.volts) : -1;
    if (idx < 0) continue;
    const arr = mafBins.get(idx) ?? [];
    arr.push(s.errorPct);
    mafBins.set(idx, arr);
  }

  const mafComponent = new Map<number, number>();
  for (const [idx, errs] of mafBins) {
    if (errs.length >= options.minSamples) mafComponent.set(idx, median(errs));
  }

  // How much of the error varies *with* airflow, rather than being a flat
  // offset that happens to appear in every bin. A constant is not a MAF slope
  // problem, so the global part is removed before measuring this.
  const binMedians = [...mafComponent.values()];
  const globalOffset = binMedians.length ? median(binMedians) : openMedian;
  const mafMagnitude = binMedians.length
    ? median(binMedians.map((m) => Math.abs(m - globalOffset)))
    : 0;

  // --- stage 2: what is left, by operating point --------------------------

  const residuals: { rpm: number; load: number; errorPct: number }[] = open.map((s) => {
    const idx = voltAxis.length ? nearestIndex(voltAxis, s.volts) : -1;
    const airflowPart = mafComponent.get(idx) ?? globalOffset;
    return { rpm: s.rpm, load: s.load, errorPct: s.errorPct - airflowPart };
  });

  let fuelMagnitude = 0;
  const fuelCells = new Map<string, number[]>();
  if (fuelTable) {
    for (const r of residuals) {
      const row = nearestIndex(fuelTable.y.values, r.rpm);
      const col = nearestIndex(fuelTable.x.values, r.load);
      const key = `${row},${col}`;
      const arr = fuelCells.get(key) ?? [];
      arr.push(r.errorPct);
      fuelCells.set(key, arr);
    }
    const cellMedians = [...fuelCells.values()]
      .filter((a) => a.length >= options.minSamples)
      .map(median);
    fuelMagnitude = cellMedians.length ? median(cellMedians.map(Math.abs)) : 0;
  }

  // --- rank the causes ----------------------------------------------------

  const causes: AfrCause[] = [];

  if (Math.abs(globalOffset) >= NEGLIGIBLE_PCT) {
    causes.push({
      id: 'global',
      label: 'A flat offset across the whole range',
      magnitudePct: Math.abs(globalOffset),
      table: null,
      explanation:
        `Fuelling is out by ${globalOffset.toFixed(1)}% everywhere, by about the same amount ` +
        'regardless of airflow or operating point. That pattern is injector sizing, fuel ' +
        'pressure, or a global MAF gain — not a shape error in any one table. No table in this ' +
        'definition corrects it: check injector scaling and fuel pressure first, because ' +
        'spreading a constant offset across a map hides the real fault.',
    });
  }

  if (mafMagnitude >= NEGLIGIBLE_PCT) {
    causes.push({
      id: 'maf',
      label: 'Error that tracks airflow',
      magnitudePct: mafMagnitude,
      table: mafTables[0]?.def.name ?? 'MAF CALIBRATION',
      explanation:
        `Beyond the flat offset, the error changes by about ${mafMagnitude.toFixed(1)}% across ` +
        'the sensor voltage range. That is the shape of the MAF transfer function being wrong, ' +
        'which is what the MAF calibration tables exist to fix.',
    });
  }

  if (fuelMagnitude >= NEGLIGIBLE_PCT && fuelTable) {
    causes.push({
      id: 'fuelMap',
      label: 'Error that depends on rpm and load',
      magnitudePct: fuelMagnitude,
      table: fuelTable.def.name,
      explanation:
        `After removing everything airflow explains, about ${fuelMagnitude.toFixed(1)}% of ` +
        'error still varies by operating point. That belongs in the fuel map rather than the ' +
        'MAF, since bending the airflow measurement to fix it would corrupt every other ' +
        'load-based calculation the ECU makes.',
    });
  }

  causes.sort((a, b) => b.magnitudePct - a.magnitudePct);

  const maxLoad = Math.max(...open.map((s) => s.load));
  notes.push(
    `${open.length.toLocaleString()} open-loop samples used, ${railed.toLocaleString()} railed ` +
      `readings and ${rejected.toLocaleString()} implausible or incomplete samples dropped.`,
  );
  notes.push(
    `Open-loop data reaches ${maxLoad.toFixed(0)} Ev% load. Nothing above that has been ` +
      'measured, so this says nothing about fuelling there — that needs a log with pulls to ' +
      'redline.',
  );

  return {
    status: 'ok',
    message: causes.length
      ? `Open loop runs ${openMedian >= 0 ? 'lean' : 'rich'} of target by ` +
        `${Math.abs(openMedian).toFixed(1)}%. Largest cause: ${causes[0].label.toLowerCase()}.`
      : `Open-loop fuelling is within ${Math.abs(openMedian).toFixed(1)}% of target. Nothing ` +
        'worth changing.',
    notes,
    closedLoopMedianPct: closedMedian,
    closedLoopSamples: closed.length,
    openLoopMedianPct: openMedian,
    openLoopSamples: open.length,
    causes,
    openLoopMaxLoad: maxLoad,
  };
}

/**
 * Turn the operating-point component into fuel map values.
 *
 * The map is a multiplier: running lean of target means the engine wanted more
 * fuel than it got, so the multiplier goes up by the error it left behind.
 */
export function recommendFuelMap(
  inputs: AfrLogInput[],
  mafTables: TableData[],
  fuelTable: TableData,
  options: AfrOptions = DEFAULT_AFR_OPTIONS,
): Recommendation {
  const analysis = analyseAfr(inputs, mafTables, fuelTable, options);
  if (analysis.status === 'blocked') {
    return blocked(analysis.message, analysis.notes);
  }

  const { open } = collect(inputs, options.loadScale ?? 1);
  const voltAxis = mafTables.flatMap((t) => t.y.values).sort((a, b) => a - b);

  // Rebuild the airflow component so the same subtraction is applied here as in
  // the diagnosis — the fuel map must only receive what the MAF cannot explain.
  const mafBins = new Map<number, number[]>();
  for (const s of open) {
    const idx = nearestIndex(voltAxis, s.volts);
    const arr = mafBins.get(idx) ?? [];
    arr.push(s.errorPct);
    mafBins.set(idx, arr);
  }
  const mafComponent = new Map<number, number>();
  for (const [idx, errs] of mafBins) {
    if (errs.length >= options.minSamples) mafComponent.set(idx, median(errs));
  }
  const binMedians = [...mafComponent.values()];
  const globalOffset = binMedians.length ? median(binMedians) : 0;

  const cells = new Map<string, number[]>();
  for (const s of open) {
    const airflowPart = mafComponent.get(nearestIndex(voltAxis, s.volts)) ?? globalOffset;
    const row = nearestIndex(fuelTable.y.values, s.rpm);
    const col = nearestIndex(fuelTable.x.values, s.load);
    const key = `${row},${col}`;
    const arr = cells.get(key) ?? [];
    arr.push(s.errorPct - airflowPart);
    cells.set(key, arr);
  }

  const suggestions = new Map<string, CellSuggestion>();
  let starved = 0;
  let skipped = 0;

  for (const [key, errs] of cells) {
    if (errs.length < options.minSamples) { starved++; continue; }
    const err = median(errs);
    const capped = Math.max(-options.maxFuelChangePct, Math.min(options.maxFuelChangePct, err));
    if (Math.abs(capped) < NEGLIGIBLE_PCT) { skipped++; continue; }

    const [r, c] = key.split(',').map(Number);
    const current = fuelTable.values[r][c];
    const value = clampAndQuantise(fuelTable.scaling, current * (1 + capped / 100), fuelTable.values);
    if (value === current) { skipped++; continue; }

    suggestions.set(key, {
      value,
      delta: value - current,
      confidence: Math.min(1, errs.length / SATURATION_SAMPLES),
      samples: errs.length,
      knock: 0,
      reason:
        `${errs.length} open-loop samples here run ${err >= 0 ? 'lean' : 'rich'} of target by ` +
        `${Math.abs(err).toFixed(1)}% after removing what the MAF transfer explains`,
    });
  }

  return {
    status: 'ok',
    message:
      `${suggestions.size} cell(s) have a fuel correction, from ${analysis.openLoopSamples} ` +
      'open-loop samples.',
    suggestions,
    notes: analysis.notes,
    skipped,
    starved,
  };
}
