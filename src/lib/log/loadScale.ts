import type { TableData } from '../rom/readTable';
import type { LogFile } from './types';
import { isPlausible } from './channelMeta';

/**
 * Reconcile the logger's Load channel with the ROM's load axis.
 *
 * A logger profile and a ROM definition can disagree about how a raw load value
 * becomes Ev%: this definition alone carries scalings differing by exactly two
 * (`Load` at x*10/32 against `Load8` at x*5/8). When they disagree, every cell
 * attribution silently lands in the wrong column — full-throttle samples get
 * filed under cruise — while every number on screen still looks reasonable.
 *
 * The ECU settles it. The commanded AFR in a log is looked up by the ECU from
 * its own AFR map at the true rpm and load, so the load interpretation that best
 * reproduces the logged Target_AFR from that map is the correct one. That is a
 * measurement rather than an assumption, and it works for any logger profile
 * instead of hard-coding one car's quirk.
 */

/** Factors worth testing: the identity, and the scaling pairs a definition mixes up. */
const CANDIDATES = [1, 2, 0.5, 4, 0.25];

export interface LoadScale {
  /** Multiply the log's Load by this to reach the ROM's Ev%. */
  factor: number;
  /** Median |AFR map − logged target| at the chosen factor, in AFR. */
  residualAfr: number;
  /** Same, for factor 1, so the improvement is visible. */
  residualAtOne: number;
  samples: number;
  confidence: 'high' | 'low' | 'unknown';
  message: string;
}

export const IDENTITY_SCALE: LoadScale = {
  factor: 1,
  residualAfr: NaN,
  residualAtOne: NaN,
  samples: 0,
  confidence: 'unknown',
  message: 'Load scale not checked.',
};

function nearestIndex(axis: number[], value: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i] - value);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Residual between the AFR the map holds and the AFR the ECU actually
 * commanded, over every enriched sample, at one candidate factor.
 */
function residualFor(
  samples: { rpm: number; load: number; target: number }[],
  afrMap: TableData,
  factor: number,
): number {
  const errs: number[] = [];
  for (const s of samples) {
    const row = nearestIndex(afrMap.y.values, s.rpm);
    const col = nearestIndex(afrMap.x.values, s.load * factor);
    const mapped = afrMap.values[row]?.[col];
    if (!Number.isFinite(mapped)) continue;
    errs.push(Math.abs(mapped - s.target));
  }
  return median(errs);
}

export function detectLoadScale(logs: LogFile[], afrMap: TableData | null): LoadScale {
  if (!afrMap || afrMap.nx < 2 || afrMap.ny < 2) {
    return { ...IDENTITY_SCALE, message: 'No AFR map loaded, so the load scale cannot be checked.' };
  }

  // Only enriched samples discriminate. Where the target is stoich the map is
  // flat across most of its load axis, so every factor fits equally well and the
  // comparison says nothing.
  const samples: { rpm: number; load: number; target: number }[] = [];
  for (const log of logs) {
    const rpm = log.byName.get('RPM');
    const load = log.byName.get('Load');
    const target = log.byName.get('Target_AFR');
    if (!rpm || !load || !target) continue;
    for (let i = 0; i < log.rowCount; i++) {
      const t = target.values[i];
      const r = rpm.values[i];
      const l = load.values[i];
      if (!isPlausible('Target_AFR', t) || Number.isNaN(r) || Number.isNaN(l)) continue;
      if (t > 14.0) continue;
      samples.push({ rpm: r, load: l, target: t });
    }
  }

  if (samples.length < 30) {
    return {
      ...IDENTITY_SCALE,
      samples: samples.length,
      message:
        `Only ${samples.length} enriched samples, too few to check the load scale. It can only ` +
        'be verified where the ECU commands enrichment, since the AFR map is flat at stoich.',
    };
  }

  const scored = CANDIDATES
    .map((factor) => ({ factor, residual: residualFor(samples, afrMap, factor) }))
    .filter((s) => Number.isFinite(s.residual))
    .sort((a, b) => a.residual - b.residual);

  if (scored.length === 0) {
    return { ...IDENTITY_SCALE, samples: samples.length, message: 'Load scale check inconclusive.' };
  }

  const best = scored[0];
  const atOne = scored.find((s) => s.factor === 1)?.residual ?? NaN;
  const runnerUp = scored[1];

  // Confident only when the winner is clearly better than both the identity and
  // the next candidate. A marginal win is not evidence of anything.
  const beatsIdentity = !Number.isFinite(atOne) || atOne > best.residual * 3;
  const beatsRunnerUp = !runnerUp || runnerUp.residual > best.residual * 2;
  const confidence: LoadScale['confidence'] =
    best.factor === 1 ? 'high' : beatsIdentity && beatsRunnerUp ? 'high' : 'low';

  const message =
    best.factor === 1
      ? `Load scale checked against the AFR map over ${samples.length} enriched samples and ` +
        `matches (${best.residual.toFixed(2)} AFR). No correction needed.`
      : confidence === 'high'
        ? `The logger's Load reads ${best.factor === 2 ? 'half' : `1/${best.factor}`} of the ` +
          `ROM's Ev%. Reconciling the logged Target_AFR with the ROM's AFR map over ` +
          `${samples.length} enriched samples: ${best.residual.toFixed(2)} AFR at ×${best.factor} ` +
          `against ${atOne.toFixed(2)} AFR untouched. Every sample is binned at ×${best.factor}, ` +
          'without which full-throttle data files itself under cruise.'
        : `Load may read ×${best.factor} of the ROM's Ev% (${best.residual.toFixed(2)} against ` +
          `${atOne.toFixed(2)} AFR), but the evidence is weak. Left uncorrected — check the ` +
          'logger profile against the definition by hand.';

  return {
    factor: confidence === 'high' ? best.factor : 1,
    residualAfr: best.residual,
    residualAtOne: atOne,
    samples: samples.length,
    confidence,
    message,
  };
}
