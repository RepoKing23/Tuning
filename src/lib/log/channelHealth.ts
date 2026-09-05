import { CHANNEL_META } from './channelMeta';
import type { LogChannel, LogFile } from './types';

export type HealthStatus = 'ok' | 'suspect' | 'dead';

export interface ChannelHealth {
  name: string;
  status: HealthStatus;
  reasons: string[];
  /** Fraction of finite samples outside the channel's plausible range. */
  outOfRangeFraction: number;
  /** Fraction of rows where the channel had no value at all. */
  nullFraction: number;
  /** True when every logged sample is identical. */
  constant: boolean;
  uniqueCount: number;
}

/** Above this fraction out of range, a channel is misconfigured rather than noisy. */
const OUT_OF_RANGE_DEAD = 0.9;
const OUT_OF_RANGE_SUSPECT = 0.2;
/**
 * A fuel trim is uninformative only when it both sits still AND sits at zero.
 * A steady +6% long-term trim is not a dead channel — it is precisely the
 * measurement a MAF correction is built from.
 */
const TRIM_MIN_SPAN_PCT = 1.0;
const TRIM_MIN_MAGNITUDE_PCT = 1.0;

function countUnique(values: Float64Array, cap: number): number {
  const seen = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    seen.add(v);
    if (seen.size > cap) return seen.size;
  }
  return seen.size;
}

function assessOne(ch: LogChannel, log: LogFile): ChannelHealth {
  const reasons: string[] = [];
  const rows = log.rowCount;
  const nullFraction = rows ? (rows - ch.n) / rows : 1;
  const uniqueCount = countUnique(ch.values, 32);
  const constant = ch.n > 0 && uniqueCount === 1;
  const meta = CHANNEL_META[ch.name];

  // 1. Never logged at all.
  if (ch.n === 0) {
    return {
      name: ch.name,
      status: 'dead',
      reasons: ['not logged — column is present but every row is empty'],
      outOfRangeFraction: 0,
      nullFraction: 1,
      constant: false,
      uniqueCount: 0,
    };
  }

  // 2. Physically implausible values.
  let outOfRange = 0;
  if (meta?.plausible) {
    const [lo, hi] = meta.plausible;
    for (let i = 0; i < ch.values.length; i++) {
      const v = ch.values[i];
      if (Number.isNaN(v)) continue;
      if (v < lo || v > hi) outOfRange++;
    }
  }
  const outOfRangeFraction = ch.n ? outOfRange / ch.n : 0;
  if (meta?.plausible && outOfRangeFraction > OUT_OF_RANGE_SUSPECT) {
    const [lo, hi] = meta.plausible;
    const pct = (outOfRangeFraction * 100).toFixed(0);
    reasons.push(
      `${pct}% of samples outside the plausible ${lo}..${hi} ${ch.unit} ` +
        `(observed ${ch.min.toFixed(1)}..${ch.max.toFixed(1)}) — likely a wrong MUT request or scaling`,
    );
  }

  // 3. Stuck at a single value where the channel should move.
  if (constant && !meta?.constantOk) {
    reasons.push(`stuck at ${ch.min} for the whole log — sensor or MUT request is dead`);
  }

  // 4. A fuel trim that barely moves carries no correction information, even
  //    though holding steady is legitimate behaviour for the channel itself.
  //    Judged on span rather than uniqueness: a trim that wanders 0.2% over a
  //    five-minute drive is just as useless as one pinned to a single value.
  const isTrim = ch.group === 'Fuel' && /^(STFT|LTFT)/.test(ch.name);
  const span = ch.max - ch.min;
  const magnitude = Math.max(Math.abs(ch.min), Math.abs(ch.max));
  if (isTrim && span < TRIM_MIN_SPAN_PCT && magnitude < TRIM_MIN_MAGNITUDE_PCT) {
    reasons.push(
      `sits at ${ch.mean.toFixed(2)}% and varies by only ${span.toFixed(2)}% across the whole ` +
        'log — no closed-loop correction was recorded, so this cannot be used to scale MAF',
    );
  }

  // 5. Coolant that never reaches operating temperature over a long running log.
  if (ch.name === 'Cooltemp' && log.duration > 60) {
    const rpm = log.byName.get('RPM');
    const running = rpm ? rpm.max > 500 : false;
    if (running && ch.max < 20) {
      reasons.push(
        `never rises above ${ch.max.toFixed(0)}°C while the engine is running — ` +
          'wrong MUT request, or the log is not reading real coolant temperature',
      );
    }
  }

  // 6. Mostly missing.
  if (nullFraction > 0.5 && ch.n > 0) {
    reasons.push(`${(nullFraction * 100).toFixed(0)}% of rows are empty`);
  }

  let status: HealthStatus = 'ok';
  if (reasons.length > 0) {
    const fatal =
      outOfRangeFraction >= OUT_OF_RANGE_DEAD ||
      (constant && !meta?.constantOk) ||
      nullFraction > 0.9;
    status = fatal ? 'dead' : 'suspect';
  }

  return { name: ch.name, status, reasons, outOfRangeFraction, nullFraction, constant, uniqueCount };
}

export function assessChannels(log: LogFile): Map<string, ChannelHealth> {
  return new Map(log.channels.map((ch) => [ch.name, assessOne(ch, log)]));
}

export type FuelFeedbackSource = 'trims' | 'wideband' | 'none';

export interface FuelFeedback {
  source: FuelFeedbackSource;
  /** Channel names the MAF recommender will read. */
  channels: string[];
  reason: string;
}

/**
 * Decide what — if anything — in this log can drive a MAF correction.
 *
 * A MAF transfer function can only be corrected against a measurement of how
 * wrong the current fuelling is. That means either the ECU's own closed-loop
 * trims or an external wideband. With neither, there is no honest answer, and
 * the recommender must refuse rather than invent numbers.
 */
export function fuelFeedback(log: LogFile, health: Map<string, ChannelHealth>): FuelFeedback {
  const usable = (name: string) => {
    const ch = log.byName.get(name);
    const h = health.get(name);
    return !!ch && !!h && h.status === 'ok' && ch.n > 0;
  };

  const trimChannels = ['STFT', 'LTFT', 'LTFT_Idle', 'LTFT_Cruise', 'LTFT_High'].filter(usable);
  const hasShort = trimChannels.some((c) => c.startsWith('STFT'));
  const hasLong = trimChannels.some((c) => c.startsWith('LTFT'));

  if (hasShort && hasLong) {
    return {
      source: 'trims',
      channels: trimChannels,
      reason: `closed-loop fuel trims (${trimChannels.join(' + ')})`,
    };
  }

  if (usable('WideBandAF') && usable('Target_AFR')) {
    return {
      source: 'wideband',
      channels: ['WideBandAF', 'Target_AFR'],
      reason: 'wideband AFR error against Target_AFR',
    };
  }

  const problems: string[] = [];
  for (const name of ['STFT', 'LTFT', 'WideBandAF']) {
    const h = health.get(name);
    if (!log.byName.has(name)) problems.push(`${name}: not present in the log`);
    else if (h && h.status !== 'ok') problems.push(`${name}: ${h.reasons[0] ?? h.status}`);
  }

  return {
    source: 'none',
    channels: [],
    reason:
      'no usable fuel feedback. MAF scaling needs either both short- and long-term fuel ' +
      'trims, or a healthy wideband with a target AFR. ' +
      problems.join('; '),
  };
}
