import type { ChannelHealth } from '../log/channelHealth';
import type { LogFile } from '../log/types';
import { clampAndQuantise } from '../rom/readTable';
import type { TableData } from '../rom/readTable';
import { median, nearestIndex } from './binning';
import { KNOCK_PER_DEGREE } from './profiles';
import { blocked } from './types';
import type { CellSuggestion, Recommendation } from './types';

/**
 * Telling real knock from phantom knock, because the two need opposite fixes.
 *
 * Real knock is combustion going wrong, and the answer is less timing in the
 * cells where it happens. Phantom knock is the sensor hearing something else —
 * piston slap, injectors, valvetrain, a loose heat shield, drivetrain shunt —
 * and the answer is in the knock-sensitivity tables, raising the noise floor at
 * the rpm where the ECU is mishearing.
 *
 * Getting this backwards is expensive in both directions. Retarding timing to
 * chase mechanical noise costs power and fixes nothing, and the noise keeps
 * triggering. Raising the noise floor to silence real knock removes the only
 * warning the engine gives before it damages itself.
 */

export type KnockVerdict = 'real' | 'phantom' | 'uncertain';

export interface KnockEvent {
  /** Seconds into the log. */
  time: number;
  logName: string;
  /** Counts added to KnockSum at this sample. */
  counts: number;
  /** Knock_change intensity, when logged. NaN otherwise. */
  intensity: number;
  rpm: number;
  /** Already in the ROM's Ev%, load scale applied. */
  load: number;
  tps: number;
  timing: number;
  coolant: number;
  verdict: KnockVerdict;
  /** Why, in the order the evidence was weighed. */
  reasons: string[];
}

export interface KnockAnalysis {
  status: 'ok' | 'blocked';
  message: string;
  notes: string[];
  events: KnockEvent[];
  realCount: number;
  phantomCount: number;
  uncertainCount: number;
  /** rpm bands where phantom events cluster, which is where the noise floor is wrong. */
  phantomRpmBands: { rpm: number; events: number }[];
}

export interface KnockLogInput {
  log: LogFile;
  health: Map<string, ChannelHealth>;
}

export interface KnockOptions {
  /** Multiplier taking the log's Load into the ROM's Ev%. */
  loadScale: number;
  /** The ECU's own load threshold per rpm, below which its knock control is inactive. */
  activeLoadThreshold?: TableData | null;
  /** Largest retard applied to a real-knock cell in one pass. */
  maxRetardDeg: number;
}

export const DEFAULT_KNOCK_OPTIONS: KnockOptions = {
  loadScale: 1,
  activeLoadThreshold: null,
  maxRetardDeg: 6,
};

/**
 * Below this load, cylinder pressure and temperature are too low for the
 * end gas to autoignite. A count here is the sensor hearing something else.
 */
const NO_KNOCK_LOAD = 30;
/** Closed throttle: no combustion load at all, so nothing can knock. */
const CLOSED_TPS = 15;
/** Piston-to-bore clearance is largest cold, and slap sounds like knock. */
const COLD_COOLANT = 60;
/** Intensity at or below this is barely above the background noise floor. */
const WEAK_INTENSITY = 6;
/** Events within this window are one burst rather than separate incidents. */
const BURST_SECONDS = 1.0;
/** An rpm band this tight, hit repeatedly across different loads, is a resonance. */
const RESONANCE_RPM_TOLERANCE = 250;
/**
 * Phantom events needed at one rpm before raising its noise floor.
 *
 * One or two isolated events are not a pattern, and every step of noise floor
 * trades away real knock sensitivity. Requiring repetition keeps the fix
 * proportionate to the evidence.
 */
const MIN_PHANTOM_TO_ACT = 3;

function thresholdAt(table: TableData | null | undefined, rpm: number): number {
  if (!table || table.ny < 2) return NaN;
  const row = nearestIndex(table.y.values, rpm);
  return table.values[row]?.[0] ?? NaN;
}

/** Raw events, before any judgement is made about them. */
function extractEvents(inputs: KnockLogInput[], loadScale: number): Omit<KnockEvent, 'verdict' | 'reasons'>[] {
  const out: Omit<KnockEvent, 'verdict' | 'reasons'>[] = [];
  for (const { log } of inputs) {
    const knock = log.byName.get('KnockSum');
    if (!knock) continue;
    const change = log.byName.get('Knock_change');
    const rpm = log.byName.get('RPM');
    const load = log.byName.get('Load');
    const tps = log.byName.get('TPS');
    const timing = log.byName.get('TimingAdv');
    const ect = log.byName.get('Cooltemp');

    for (let i = 1; i < log.rowCount; i++) {
      const cur = knock.values[i];
      const prev = knock.values[i - 1];
      if (Number.isNaN(cur) || Number.isNaN(prev) || cur <= prev) continue;
      out.push({
        time: log.time[i],
        logName: log.name,
        counts: cur - prev,
        intensity: change ? change.values[i] : NaN,
        rpm: rpm ? rpm.values[i] : NaN,
        load: load ? load.values[i] * loadScale : NaN,
        tps: tps ? tps.values[i] : NaN,
        timing: timing ? timing.values[i] : NaN,
        coolant: ect ? ect.values[i] : NaN,
      });
    }
  }
  return out;
}

/**
 * rpm values hit repeatedly across widely differing loads.
 *
 * A component that rings at one frequency triggers the sensor at the rpm that
 * excites it regardless of how hard the engine is working, which is the opposite
 * of real knock — that follows load, not rpm.
 */
function resonantRpms(events: Omit<KnockEvent, 'verdict' | 'reasons'>[]): Set<number> {
  const resonant = new Set<number>();
  for (const e of events) {
    if (Number.isNaN(e.rpm)) continue;
    const near = events.filter((o) => Math.abs(o.rpm - e.rpm) <= RESONANCE_RPM_TOLERANCE);
    if (near.length < 4) continue;
    const loads = near.map((o) => o.load).filter(Number.isFinite);
    if (loads.length < 4) continue;
    const spread = Math.max(...loads) - Math.min(...loads);
    // Same rpm, load all over the place: the rpm is what they have in common.
    if (spread > 40) resonant.add(e.rpm);
  }
  return resonant;
}

export function analyseKnock(
  inputs: KnockLogInput[],
  options: KnockOptions = DEFAULT_KNOCK_OPTIONS,
): KnockAnalysis {
  const empty = { events: [], realCount: 0, phantomCount: 0, uncertainCount: 0, phantomRpmBands: [] };
  if (inputs.length === 0) return { ...blocked('No logs selected.'), ...empty };

  const usable = inputs.some((i) => i.health.get('KnockSum')?.status === 'ok');
  if (!usable) {
    return {
      ...blocked(
        'No log has a usable KnockSum channel, so there is nothing to analyse. Knock feedback ' +
          'is the one channel timing work cannot proceed without.',
      ),
      ...empty,
    };
  }

  const raw = extractEvents(inputs, options.loadScale);
  const notes: string[] = [];

  if (raw.length === 0) {
    return {
      status: 'ok',
      message: 'No knock recorded in these logs.',
      notes: [
        'That is the result you want, but it only covers where you drove. Knock appears under ' +
          'load and heat, so a log without sustained high-load running has not really tested for it.',
      ],
      ...empty,
    };
  }

  const resonant = resonantRpms(raw);
  const hasIntensity = raw.some((e) => Number.isFinite(e.intensity));

  const events: KnockEvent[] = raw.map((e) => {
    const real: string[] = [];
    const phantom: string[] = [];

    // Load and throttle: knock needs cylinder pressure. This is the strongest
    // single discriminator, so it is weighed first.
    if (Number.isFinite(e.load)) {
      if (e.load < NO_KNOCK_LOAD) {
        phantom.push(
          `only ${e.load.toFixed(0)} Ev% load — too little cylinder pressure for the end gas to ` +
          'autoignite',
        );
      } else {
        real.push(`${e.load.toFixed(0)} Ev% load, enough cylinder pressure to knock`);
      }
    }
    if (Number.isFinite(e.tps) && e.tps < CLOSED_TPS) {
      phantom.push(`throttle nearly closed at ${e.tps.toFixed(0)}%, so there is no combustion load`);
    }

    // The ECU's own opinion: below its threshold it does not act on knock at all.
    const threshold = thresholdAt(options.activeLoadThreshold, e.rpm);
    if (Number.isFinite(threshold) && Number.isFinite(e.load) && e.load < threshold) {
      phantom.push(
        `below the ROM's own knock-control threshold of ${threshold.toFixed(0)} Ev% at this rpm, ` +
        'so the ECU would not act on it either',
      );
    } else if (Number.isFinite(threshold)) {
      real.push(`above the ECU's ${threshold.toFixed(0)} Ev% knock-control threshold`);
    }

    // Intensity, where the logger provides it.
    if (Number.isFinite(e.intensity)) {
      if (e.intensity <= WEAK_INTENSITY) {
        phantom.push(`weak signal (${e.intensity.toFixed(0)}), barely above the noise floor`);
      } else {
        real.push(`strong signal (${e.intensity.toFixed(0)}) well above the noise floor`);
      }
    }

    // Timing: real knock is provoked by advance.
    if (Number.isFinite(e.timing) && e.timing > 25) {
      real.push(`${e.timing.toFixed(0)}° of advance, enough to provoke knock`);
    }

    // Cold engine: piston slap.
    if (Number.isFinite(e.coolant) && e.coolant < COLD_COOLANT) {
      phantom.push(`engine cold at ${e.coolant.toFixed(0)}°C, where piston slap sounds like knock`);
    }

    // Clustering: a burst is combustion repeating; a lone tick is noise.
    const burst = raw.filter(
      (o) => o.logName === e.logName && Math.abs(o.time - e.time) <= BURST_SECONDS,
    ).length;
    if (burst >= 2) real.push(`part of a burst of ${burst} events within a second`);

    if (resonant.has(e.rpm)) {
      phantom.push(
        `this rpm keeps triggering across completely different loads, which is a mechanical ` +
        'resonance rather than combustion',
      );
    }

    const verdict: KnockVerdict =
      phantom.length > real.length ? 'phantom' : real.length > phantom.length ? 'real' : 'uncertain';

    return { ...e, verdict, reasons: verdict === 'phantom' ? phantom : real.length ? real : phantom };
  });

  const realCount = events.filter((e) => e.verdict === 'real').length;
  const phantomCount = events.filter((e) => e.verdict === 'phantom').length;
  const uncertainCount = events.filter((e) => e.verdict === 'uncertain').length;

  // Where phantom events pile up is where the noise floor needs raising.
  const bands = new Map<number, number>();
  for (const e of events) {
    if (e.verdict !== 'phantom' || !Number.isFinite(e.rpm)) continue;
    const band = Math.round(e.rpm / 500) * 500;
    bands.set(band, (bands.get(band) ?? 0) + 1);
  }
  const phantomRpmBands = [...bands.entries()]
    .map(([rpm, n]) => ({ rpm, events: n }))
    .sort((a, b) => b.events - a.events);

  if (!hasIntensity) {
    notes.push(
      'Knock_change is not logged, so signal strength could not be weighed. Logging it makes ' +
        'this judgement considerably more reliable — a count with a weak signal behind it is ' +
        'usually noise.',
    );
  }
  if (options.loadScale !== 1) {
    notes.push(
      `Load has been scaled by ×${options.loadScale} to match the ROM's axis. Without that, ` +
        'these events would appear at half their real load and read as phantom.',
    );
  }
  if (realCount > 0) {
    notes.push(
      `${realCount} event(s) look like real knock. Pull timing where they occur and re-log ` +
        'before changing anything else — knock that keeps repeating after a retard is either ' +
        'worse than it looks or is not knock.',
    );
  }
  if (phantomCount > 0) {
    notes.push(
      `${phantomCount} event(s) look like the sensor hearing something other than combustion. ` +
        'Those are fixed by raising the knock-sensitivity noise floor at the affected rpm, not ' +
        'by removing timing.',
    );
  }

  return {
    status: 'ok',
    message:
      `${events.length} knock event(s): ${realCount} real, ${phantomCount} phantom, ` +
      `${uncertainCount} uncertain.`,
    notes,
    events: events.sort((a, b) => b.counts - a.counts),
    realCount,
    phantomCount,
    uncertainCount,
    phantomRpmBands,
  };
}

/**
 * Timing retard for the cells where knock looks real.
 *
 * Deliberately ignores phantom events: pulling timing at an rpm where the sensor
 * is mishearing noise costs power and leaves the noise still triggering.
 */
export function recommendKnockRetard(
  inputs: KnockLogInput[],
  sparkTable: TableData,
  options: KnockOptions = DEFAULT_KNOCK_OPTIONS,
): Recommendation {
  const analysis = analyseKnock(inputs, options);
  if (analysis.status === 'blocked') return blocked(analysis.message, analysis.notes);

  const cells = new Map<string, KnockEvent[]>();
  for (const e of analysis.events) {
    if (e.verdict !== 'real') continue;
    if (Number.isNaN(e.rpm) || Number.isNaN(e.load)) continue;
    const row = nearestIndex(sparkTable.y.values, e.rpm);
    const col = nearestIndex(sparkTable.x.values, e.load);
    const key = `${row},${col}`;
    cells.set(key, [...(cells.get(key) ?? []), e]);
  }

  const suggestions = new Map<string, CellSuggestion>();
  for (const [key, evs] of cells) {
    const [r, c] = key.split(',').map(Number);
    const current = sparkTable.values[r][c];
    const counts = evs.reduce((n, e) => n + e.counts, 0);
    const degrees = Math.min(options.maxRetardDeg, Math.max(1, Math.ceil(counts / KNOCK_PER_DEGREE)));
    const value = clampAndQuantise(sparkTable.scaling, current - degrees, sparkTable.values);
    if (value === current) continue;

    suggestions.set(key, {
      value,
      delta: value - current,
      // Knock is acted on regardless of how many samples the cell holds: one
      // real knock event is enough reason to take timing out of it.
      confidence: 0.9,
      samples: evs.length,
      knock: counts,
      reason:
        `${counts} knock count(s) across ${evs.length} event(s) judged real — ` +
        `${evs[0].reasons.slice(0, 2).join('; ')}. Pulling ${degrees}°.`,
    });
  }

  return {
    status: 'ok',
    message: suggestions.size
      ? `${suggestions.size} cell(s) recorded real knock and should lose timing. ` +
        `${analysis.phantomCount} phantom event(s) were deliberately left alone.`
      : analysis.phantomCount > 0
        ? `No real knock to retard. All ${analysis.phantomCount} event(s) look like sensor ` +
          'noise, which timing cannot fix.'
        : 'No knock to act on.',
    suggestions,
    notes: analysis.notes,
    skipped: analysis.phantomCount,
    starved: 0,
  };
}

/**
 * Raise the knock-sensitivity noise floor where the sensor is mishearing.
 *
 * The adder tables are 2D against rpm, so a phantom band maps onto specific rows
 * rather than a region of the map. The step is deliberately small: raising the
 * floor too far makes the ECU deaf to real knock at that rpm.
 */
export function recommendNoiseFloor(
  inputs: KnockLogInput[],
  adderTable: TableData,
  options: KnockOptions = DEFAULT_KNOCK_OPTIONS,
): Recommendation {
  const analysis = analyseKnock(inputs, options);
  if (analysis.status === 'blocked') return blocked(analysis.message, analysis.notes);

  if (analysis.phantomCount === 0) {
    return blocked(
      'No phantom knock found, so the noise floor does not need raising. Raising it without ' +
        'evidence makes the ECU deaf to real knock.',
      analysis.notes,
    );
  }

  const actionable = analysis.phantomRpmBands.filter((b) => b.events >= MIN_PHANTOM_TO_ACT);
  if (actionable.length === 0) {
    return blocked(
      `Phantom events are scattered rather than clustered: no single rpm has ${MIN_PHANTOM_TO_ACT} ` +
        'or more. That is not enough of a pattern to justify making the ECU less sensitive to ' +
        'knock, since every step traded here is knock sensitivity given up everywhere.',
      analysis.notes,
    );
  }

  const suggestions = new Map<string, CellSuggestion>();
  for (const band of actionable) {
    const row = nearestIndex(adderTable.y.values, band.rpm);
    const current = adderTable.values[row]?.[0];
    if (!Number.isFinite(current)) continue;
    // One increment of the scaling: the smallest step the ECU can store.
    const value = clampAndQuantise(
      adderTable.scaling,
      current + adderTable.scaling.inc,
      adderTable.values,
    );
    if (value === current) continue;
    suggestions.set(`${row},0`, {
      value,
      delta: value - current,
      confidence: Math.min(1, band.events / 5),
      samples: band.events,
      knock: 0,
      reason:
        `${band.events} phantom event(s) near ${band.rpm} rpm. Raising the noise floor by one ` +
        'step so the sensor stops reporting this. Re-log and confirm real knock is still ' +
        'detected before going further.',
    });
  }

  return {
    status: 'ok',
    message:
      `${suggestions.size} rpm row(s) raised to stop the sensor mishearing. ` +
      'Raise this only as far as the phantom events need.',
    suggestions,
    notes: [
      ...analysis.notes,
      'Every step here trades knock sensitivity for quiet. Too far and the ECU stops hearing ' +
        'real knock, which is the only warning the engine gives before damage.',
    ],
    skipped: 0,
    starved: 0,
  };
}

/** Median load of real events, useful for reporting. */
export function medianRealLoad(analysis: KnockAnalysis): number {
  return median(analysis.events.filter((e) => e.verdict === 'real').map((e) => e.load));
}
