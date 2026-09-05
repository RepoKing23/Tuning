import { fuelFeedback } from '../log/channelHealth';
import { isPlausible } from '../log/channelMeta';
import type { ChannelHealth } from '../log/channelHealth';
import type { LogFile } from '../log/types';
import { clampAndQuantise } from '../rom/readTable';
import type { TableData } from '../rom/readTable';
import { median, nearestIndex } from './binning';
import { MIN_SAMPLES, SATURATION_SAMPLES } from './profiles';
import { blocked } from './types';
import type { CellSuggestion, Recommendation } from './types';

export interface MafOptions {
  /** Largest proportional change applied to a bin in one pass, in percent. */
  maxChangePct: number;
  /** Samples needed in a bin before it is touched. */
  minSamples: number;
  /** Average each bin with its neighbours to keep the transfer smooth. */
  smooth: boolean;
  /** Force the transfer to stay non-decreasing with voltage. */
  enforceMonotonic: boolean;
  /** Reject samples where |dMAF/dt| exceeds this, in volts per second. */
  maxVoltRate: number;
}

/**
 * Fuelling error beyond this is not a MAF transfer problem — it is enrichment,
 * a fuel cut, or a sensor artefact.
 */
const MAX_CREDIBLE_ERROR_PCT = 40;

/**
 * A commanded target at or above this counts as closed loop.
 *
 * In closed loop the ECU's own O2 feedback drives measured AFR onto the target
 * whatever the MAF is doing, so the wideband error there is ~0 by construction
 * and measures nothing. Averaging those samples in dilutes the real open-loop
 * signal and makes the correction too small. The error has not vanished — it
 * has moved into the fuel trims, which is where the trims path reads it.
 */
export const CLOSED_LOOP_TARGET_AFR = 14.6;

export const DEFAULT_MAF_OPTIONS: MafOptions = {
  maxChangePct: 10,
  minSamples: MIN_SAMPLES,
  smooth: true,
  enforceMonotonic: true,
  maxVoltRate: 1.5,
};

export interface MafLogInput {
  log: LogFile;
  health: Map<string, ChannelHealth>;
}

/**
 * Correct a MAF transfer function from logged fuelling error.
 *
 * The measurement is "how wrong is the fuelling right now" — closed-loop trims
 * if the ECU is reporting them, otherwise wideband AFR against the ECU's own
 * target. A positive error means the ECU had to add fuel, which means the MAF
 * under-reported airflow, which means the table value at that voltage is low.
 *
 * With neither trims nor a wideband there is no measurement, and this returns
 * `blocked` rather than a plausible-looking table.
 */
export function recommendMaf(
  inputs: MafLogInput[],
  table: TableData,
  options: MafOptions = DEFAULT_MAF_OPTIONS,
): Recommendation {
  if (inputs.length === 0) return blocked('No logs selected.');
  if (table.nx !== 1 || table.ny < 2) {
    return blocked(
      `${table.def.name} is not a MAF transfer table (expected a single column against a ` +
        'voltage axis).',
    );
  }

  const voltAxis = table.y.values;
  // Each MAF part covers only a slice of the sensor's range. nearestIndex
  // clamps, so without this guard a 4.0 V sample would be attributed to Part 1's
  // 1.68 V end bin and corrupt it.
  const axisLo = voltAxis[0];
  const axisHi = voltAxis[voltAxis.length - 1];
  const step = voltAxis.length > 1 ? (axisHi - axisLo) / (voltAxis.length - 1) : 0;
  const inThisPart = (v: number) => v >= axisLo - step / 2 && v <= axisHi + step / 2;

  const usable = inputs
    .map((i) => ({ ...i, feedback: fuelFeedback(i.log, i.health) }))
    .filter((i) => i.feedback.source !== 'none');

  if (usable.length === 0) {
    const reasons = inputs.map(
      (i) => `${i.log.name}: ${fuelFeedback(i.log, i.health).reason}`,
    );
    return blocked(
      'MAF scaling is blocked — none of the selected logs carry a usable fuelling error.',
      [
        ...reasons,
        'Fix this by logging STFT and LTFT together (EvoScan MUT requests), or by adding a ' +
          'wideband and logging WideBandAF alongside Target_AFR. Until then any MAF number ' +
          'this tool produced would be invented rather than measured.',
      ],
    );
  }

  // Accumulate the fuelling error observed at each voltage breakpoint.
  const errorsPerBin: number[][] = voltAxis.map(() => []);
  const notes: string[] = [];
  let considered = 0;
  let rejected = 0;
  let railed = 0;
  let outOfPart = 0;
  let closedLoop = 0;

  for (const { log, feedback } of usable) {
    const maf = log.byName.get('MAF_Voltage');
    if (!maf) { notes.push(`${log.name}: no MAF_Voltage channel, skipped.`); continue; }

    // Use whatever fuelFeedback actually selected, rather than assuming the
    // generic names: on this ECU the informative long-term trim is often a
    // region-specific channel like LTFT_Cruise while plain LTFT reads zero.
    const trimChannels = feedback.channels
      .map((n) => log.byName.get(n))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const wb = log.byName.get('WideBandAF');
    const target = log.byName.get('Target_AFR');
    const rpm = log.byName.get('RPM');

    for (let i = 1; i < log.rowCount; i++) {
      const v = maf.values[i];
      if (Number.isNaN(v)) { rejected++; continue; }

      // The sensor and the fuel system both lag; only settled samples say
      // anything about steady-state fuelling.
      const dt = log.time[i] - log.time[i - 1];
      if (dt > 0 && Math.abs((v - maf.values[i - 1]) / dt) > options.maxVoltRate) {
        rejected++;
        continue;
      }
      if (rpm && !Number.isNaN(rpm.values[i]) && rpm.values[i] < 500) { rejected++; continue; }
      if (!inThisPart(v)) { rejected++; outOfPart++; continue; }

      let error: number;
      if (feedback.source === 'trims') {
        // Total correction the ECU is applying: short- plus long-term.
        let total = 0;
        let seen = 0;
        for (const ch of trimChannels) {
          const v = ch.values[i];
          if (Number.isNaN(v)) continue;
          total += v;
          seen++;
        }
        if (seen === 0) { rejected++; continue; }
        error = total;
      } else {
        const measured = wb ? wb.values[i] : NaN;
        const want = target ? target.values[i] : NaN;
        // Rail values are sentinels, not measurements: a wideband reports 0
        // before light-off and 99.9 outside its measurable range. Rejected per
        // sample so the rest of the channel stays usable.
        if (!isPlausible('WideBandAF', measured) || !isPlausible('Target_AFR', want) || want <= 0) {
          rejected++;
          railed++;
          continue;
        }
        if (want >= CLOSED_LOOP_TARGET_AFR) {
          rejected++;
          closedLoop++;
          continue;
        }
        // Lean of target means less fuel went in than intended, which means the
        // MAF over-reported air. Sign matches the trim convention.
        error = (measured / want - 1) * -100;
        // Beyond this the sample is transient enrichment or a sensor artefact,
        // not a transfer-function error.
        if (Math.abs(error) > MAX_CREDIBLE_ERROR_PCT) { rejected++; continue; }
      }

      errorsPerBin[nearestIndex(voltAxis, v)].push(error);
      considered++;
    }
  }

  if (considered === 0 && closedLoop > 0) {
    return blocked(
      `Every usable sample in this part's voltage range was closed loop, where the ECU's own ` +
        'O2 feedback holds AFR on target regardless of MAF error. Log some enrichment — part ' +
        'or full throttle — so the wideband has something real to measure.',
      notes,
    );
  }

  if (considered === 0) {
    return blocked(
      outOfPart > 0
        ? `None of the logged MAF voltages fall inside ${table.def.name} ` +
          `(${axisLo.toFixed(2)}–${axisHi.toFixed(2)} V). Try another MAF part.`
        : 'No steady-state samples with fuelling error survived filtering.',
      notes,
    );
  }

  // Proposed multiplier per bin, before smoothing and monotonicity.
  const current = table.values.map((r) => r[0]);
  const proposed = [...current];
  const perBin: { n: number; error: number }[] = voltAxis.map((_, i) => ({
    n: errorsPerBin[i].length,
    error: errorsPerBin[i].length ? median(errorsPerBin[i]) : NaN,
  }));

  let starved = 0;
  let skipped = 0;

  for (let i = 0; i < voltAxis.length; i++) {
    const { n, error } = perBin[i];
    if (n < options.minSamples) { starved++; continue; }
    if (!Number.isFinite(error)) { starved++; continue; }
    const capped = Math.max(-options.maxChangePct, Math.min(options.maxChangePct, error));
    if (Math.abs(capped) < 0.5) { skipped++; continue; }
    proposed[i] = current[i] * (1 + capped / 100);
  }

  if (options.smooth) {
    const smoothed = [...proposed];
    for (let i = 1; i < proposed.length - 1; i++) {
      // Only smooth bins that actually moved; leave untouched bins untouched.
      if (proposed[i] === current[i]) continue;
      smoothed[i] = proposed[i] * 0.5 + proposed[i - 1] * 0.25 + proposed[i + 1] * 0.25;
    }
    for (let i = 0; i < proposed.length; i++) proposed[i] = smoothed[i];
  }

  if (options.enforceMonotonic) {
    // Airflow cannot fall as sensor voltage rises. A non-monotonic transfer
    // makes the ECU's reverse lookup ambiguous and drives fuelling unstable.
    let fixed = 0;
    for (let i = 1; i < proposed.length; i++) {
      if (proposed[i] < proposed[i - 1]) { proposed[i] = proposed[i - 1]; fixed++; }
    }
    if (fixed > 0) {
      notes.push(`${fixed} bin(s) were raised to keep the transfer non-decreasing with voltage.`);
    }
  }

  const suggestions = new Map<string, CellSuggestion>();
  for (let i = 0; i < voltAxis.length; i++) {
    const value = clampAndQuantise(table.scaling, proposed[i], table.values);
    if (value === current[i]) continue;
    const { n, error } = perBin[i];
    suggestions.set(`${i},0`, {
      value,
      delta: value - current[i],
      confidence: Math.min(1, n / SATURATION_SAMPLES),
      samples: n,
      knock: 0,
      reason:
        n >= options.minSamples
          ? `median fuelling error ${error.toFixed(1)}% across ${n} steady samples at ` +
            `${voltAxis[i].toFixed(2)} V`
          : 'adjusted to keep the transfer monotonic and smooth',
    });
  }

  const source = usable[0].feedback.reason;
  notes.push(
    `${considered.toLocaleString()} samples used, ${rejected.toLocaleString()} rejected as ` +
      'transient, out of range or incomplete' +
      (railed > 0
        ? ` (${railed.toLocaleString()} of those were railed sensor values such as 0 or 99.9 AFR)`
        : '') +
      '.',
  );
  if (closedLoop > 0) {
    notes.push(
      `${closedLoop.toLocaleString()} closed-loop samples were excluded. Their error is ~0 by ` +
        'construction, since O2 feedback holds AFR on target no matter how wrong the MAF is, ' +
        'so including them would only shrink the correction.',
    );
  }
  if (outOfPart > 0) {
    notes.push(
      `${outOfPart.toLocaleString()} samples fell outside this part's ` +
        `${axisLo.toFixed(2)}–${axisHi.toFixed(2)} V range and were left for the other MAF ` +
        'parts, rather than being clamped onto the end bins.',
    );
  }
  notes.push(
    'Re-log after applying. MAF correction is iterative: one pass moves the transfer most ' +
      'of the way, the next pass confirms it.',
  );

  return {
    status: 'ok',
    message: suggestions.size === 0
      ? `No correction: not enough usable samples in any of ${table.def.name}'s ` +
        `${voltAxis.length} voltage bins (${axisLo.toFixed(2)}-${axisHi.toFixed(2)} V). ` +
        (closedLoop > 0
          ? 'Closed-loop samples cannot fill them on the wideband path, because O2 feedback ' +
            'holds AFR on target there whatever the MAF says. Either log fuel trims so the ' +
            'correction can be read directly, or drive more part- and full-throttle.'
          : 'Drive more of the airflow range this part covers and log again.')
      : `${suggestions.size} of ${voltAxis.length} voltage bins have a correction, using ` +
        `${source}.`,
    suggestions,
    notes,
    skipped,
    starved,
  };
}
