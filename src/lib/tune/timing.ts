import type { ChannelHealth } from '../log/channelHealth';
import type { LogFile } from '../log/types';
import { clampAndQuantise } from '../rom/readTable';
import type { TableData } from '../rom/readTable';
import { binLog, DEFAULT_FILTER, iqr, median, OVERRUN_FILTER } from './binning';
import type { CellStats } from './binning';
import {
  advanceCeiling, KNOCK_PER_DEGREE, MIN_SAMPLES, PROFILES, SATURATION_SAMPLES,
} from './profiles';
import type { ProfileId } from './profiles';
import { blocked } from './types';
import type { CellSuggestion, Recommendation } from './types';

export interface TimingLogInput {
  log: LogFile;
  health: Map<string, ChannelHealth>;
}

export interface TimingOptions {
  profile: ProfileId;
  /** Samples needed in a cell before it is touched. */
  minSamples: number;
  /** Scales every step; 1.0 uses the profile's nominal aggression. */
  intensity: number;
  /** Restrict analysis to a time window. */
  timeRange?: [number, number] | null;
}

export const DEFAULT_TIMING_OPTIONS: TimingOptions = {
  profile: 'eco',
  minSamples: MIN_SAMPLES,
  intensity: 1,
  timeRange: null,
};

function mergeCells(a: CellStats, b: CellStats): CellStats {
  const values = new Map(a.values);
  for (const [name, arr] of b.values) {
    values.set(name, [...(values.get(name) ?? []), ...arr]);
  }
  return { n: a.n + b.n, knock: a.knock + b.knock, values };
}

/**
 * Suggest spark map changes from logged evidence, under a tune personality.
 *
 * Two rules hold in every profile and are enforced in code rather than left to
 * the profile constants:
 *
 *  - A cell that recorded knock never gets advance. It gets retard proportional
 *    to how much knock was seen.
 *  - No cell is advanced past the load-dependent ceiling, or outside the range
 *    the ROM's own scaling can store.
 *
 * A cell with too few samples is left alone and reported as starved. Silence is
 * the correct output for a cell the logs never really visited.
 */
export function recommendTiming(
  inputs: TimingLogInput[],
  table: TableData,
  options: TimingOptions = DEFAULT_TIMING_OPTIONS,
): Recommendation {
  if (inputs.length === 0) return blocked('No logs selected.');
  if (table.def.dims !== '3D') return blocked(`${table.def.name} is not a 3D spark map.`);

  const profile = PROFILES[options.profile];
  const notes: string[] = [];

  if (table.nx < 2 || table.ny < 2) {
    return blocked(`${table.def.name} is not a 3D spark map.`);
  }

  const rpmAxis = table.y.values;
  const loadAxis = table.x.values;

  // Knock is the one channel this analysis cannot proceed without.
  const knockUsable = inputs.some((i) => i.health.get('KnockSum')?.status === 'ok');
  if (!knockUsable) {
    return blocked(
      'Timing suggestions are blocked — no log has a usable KnockSum channel, and advancing ' +
        'timing without knock feedback is how engines get damaged.',
      inputs.map((i) => `${i.log.name}: KnockSum ${i.health.get('KnockSum')?.status ?? 'missing'}`),
    );
  }

  // Overrun profiles need the samples the normal filter throws away.
  const filter = profile.overrun ? OVERRUN_FILTER : DEFAULT_FILTER;

  let merged: CellStats[][] | null = null;
  let totalUsed = 0;
  for (const { log, health } of inputs) {
    const binned = binLog(log, {
      xAxis: loadAxis,
      yAxis: rpmAxis,
      xChannel: 'Load',
      yChannel: 'RPM',
      collect: ['TimingAdv', 'Load', 'RPM'],
      filter,
      timeRange: options.timeRange,
      ignoreCoolant: health.get('Cooltemp')?.status !== 'ok',
    });
    totalUsed += binned.used;
    merged = merged
      ? merged.map((row, r) => row.map((cell, c) => mergeCells(cell, binned.cells[r][c])))
      : binned.cells;

    if (health.get('Cooltemp')?.status !== 'ok') {
      notes.push(
        `${log.name}: coolant temperature is unreliable, so the warm-engine filter was ` +
          'skipped. Cold-engine samples may be mixed in.',
      );
    }
  }
  if (!merged) return blocked('No usable samples.');
  if (totalUsed === 0) {
    return blocked(
      'No samples survived filtering. ' +
        (profile.overrun
          ? 'Overrun profiles need closed-throttle decelerations in the log.'
          : 'Try a log with more steady-state cruising, or widen the time window.'),
    );
  }

  const suggestions = new Map<string, CellSuggestion>();
  let starved = 0;
  let skipped = 0;
  let knockCells = 0;
  let ceilingHits = 0;

  for (let r = 0; r < rpmAxis.length; r++) {
    for (let c = 0; c < loadAxis.length; c++) {
      const cell = merged[r][c];
      const rpm = rpmAxis[r];
      const load = loadAxis[c];
      const current = table.values[r][c];

      if (cell.n === 0) continue;
      if (cell.n < options.minSamples) { starved++; continue; }

      const confidence = Math.min(1, cell.n / SATURATION_SAMPLES);
      const logged = cell.values.get('TimingAdv') ?? [];
      const spread = iqr(logged);

      let delta = 0;
      let reason = '';

      if (cell.knock > 0) {
        // Safety first, in every profile, inside the target region or not.
        knockCells++;
        const degrees = Math.min(profile.maxRetard, Math.ceil(cell.knock / KNOCK_PER_DEGREE));
        delta = -degrees;
        reason =
          `${cell.knock} knock count(s) recorded here across ${cell.n} samples — ` +
          `pulling ${degrees}°. Knock always overrides the profile.`;
      } else if (!profile.region(rpm, load)) {
        skipped++;
        continue;
      } else if (profile.overrun) {
        // Retard into the exhaust stroke to burn fuel there rather than in the
        // cylinder. Scaled by how far into the band this cell sits.
        const step = Math.round(profile.maxRetard * profile.aggression * options.intensity);
        if (step <= 0) { skipped++; continue; }
        delta = -step;
        reason =
          `overrun cell: retarding ${step}° so combustion finishes in the exhaust ` +
          `(${cell.n} samples, no knock recorded)`;
      } else if (profile.maxAdvance <= 0) {
        skipped++;
        continue;
      } else {
        const step = profile.maxAdvance * profile.aggression * options.intensity * confidence;
        const rounded = Math.round(step);
        if (rounded <= 0) { skipped++; continue; }

        const ceiling = advanceCeiling(load);
        const allowed = Math.min(rounded, Math.max(0, ceiling - current));
        if (allowed <= 0) {
          ceilingHits++;
          skipped++;
          continue;
        }
        if (allowed < rounded) ceilingHits++;

        delta = allowed;
        reason =
          `${cell.n} clean samples, no knock — adding ${allowed}° ` +
          `(ceiling for ${Math.round(load)} Ev% is ${ceiling.toFixed(0)}°` +
          (spread > 3 ? `; logged timing spread was ${spread.toFixed(1)}°, so this is cautious` : '') +
          ')';
      }

      if (delta === 0) { skipped++; continue; }

      const value = clampAndQuantise(table.scaling, current + delta);
      if (value === current) { skipped++; continue; }

      suggestions.set(`${r},${c}`, {
        value,
        delta: value - current,
        // A knock-driven retard is acted on regardless of sample count.
        confidence: cell.knock > 0 ? Math.max(confidence, 0.8) : confidence,
        samples: cell.n,
        knock: cell.knock,
        reason,
      });
    }
  }

  if (knockCells > 0) {
    notes.push(
      `${knockCells} cell(s) recorded knock and were retarded regardless of the selected ` +
        'profile. Re-log and confirm the knock is gone before advancing anything else.',
    );
  }
  if (ceilingHits > 0) {
    notes.push(
      `${ceilingHits} cell(s) were limited by the load-dependent advance ceiling. Those ` +
        'defaults are conservative pump-fuel values, not measurements from your engine.',
    );
  }
  if (starved > 0) {
    notes.push(
      `${starved} cell(s) had samples but fewer than ${options.minSamples}, so they were left ` +
        'alone. Drive those areas and log again.',
    );
  }
  if (profile.overrun) {
    notes.push(
      'Spark retard alone gives a soft burble. The crackle comes from fuel still being ' +
        'injected on the overrun — see the decel and fuel-cut tables listed below.',
    );
  }

  const summary = median(
    [...suggestions.values()].map((s) => s.delta),
  );

  return {
    status: 'ok',
    message:
      `${suggestions.size} cell(s) have a suggested change under the ${profile.label} profile` +
      (Number.isFinite(summary) ? `, median ${summary >= 0 ? '+' : ''}${summary.toFixed(1)}°` : '') +
      `. ${totalUsed.toLocaleString()} samples binned.`,
    suggestions,
    notes,
    skipped,
    starved,
  };
}
