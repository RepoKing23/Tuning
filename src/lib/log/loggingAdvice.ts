import { fuelFeedback } from './channelHealth';
import type { ChannelHealth } from './channelHealth';
import type { LogFile } from './types';

/**
 * What to change about the logging setup, derived from the logs themselves.
 *
 * Most of what limits a tune is not the analysis but the data: a channel
 * requested with the wrong MUT id, a sample rate too coarse to resolve a pull,
 * a region of the map never driven. Those are all visible in the log, and each
 * has a specific fix, so the app can say what to do rather than leaving the
 * tuner to infer it from a wall of red badges.
 */

export type AdviceSeverity = 'blocking' | 'important' | 'minor';

export interface Advice {
  id: string;
  severity: AdviceSeverity;
  title: string;
  detail: string;
  /** What becomes possible once this is fixed. */
  unlocks: string;
}

/** Channels that cannot return data on this car, so requesting them only costs rate. */
const IRRELEVANT_ON_5MT = [
  'OddClutchTemp', 'EvenClutchTemp', 'OddClutchPressure', 'EvenClutchPressure',
  'OddClutchSlipSpeed', 'EvenClutchSlipSpeed', 'OddInputShaftSpeed', 'EvenInputShaftSpeed',
  'Trans_Temp',
];
const IRRELEVANT_ON_NA = ['Boost', 'ActiveWGDC'];

/** Below this a pull through the rev range is too coarse to tune against. */
const SLOW_SAMPLE_HZ = 8;

export interface AdviceInput {
  log: LogFile;
  health: Map<string, ChannelHealth>;
}

export function loggingAdvice(inputs: AdviceInput[]): Advice[] {
  if (inputs.length === 0) return [];
  const advice: Advice[] = [];

  const anyOf = (fn: (i: AdviceInput) => boolean) => inputs.some(fn);
  const dead = (i: AdviceInput, name: string) => {
    const h = i.health.get(name);
    return !!h && h.status !== 'ok';
  };
  const emptyEverywhere = (name: string) =>
    inputs.every((i) => {
      const ch = i.log.byName.get(name);
      return !!ch && ch.n === 0;
    });

  // --- sample rate --------------------------------------------------------

  const rates = inputs.map((i) => (i.log.sampleInterval > 0 ? 1 / i.log.sampleInterval : NaN));
  const slowest = Math.min(...rates.filter(Number.isFinite));
  if (Number.isFinite(slowest) && slowest < SLOW_SAMPLE_HZ) {
    const deadRequests = new Set<string>();
    for (const i of inputs) {
      for (const name of [...IRRELEVANT_ON_5MT, ...IRRELEVANT_ON_NA]) {
        const ch = i.log.byName.get(name);
        if (ch && ch.n === 0) deadRequests.add(name);
      }
      for (const ch of i.log.channels) {
        if (ch.n === 0) deadRequests.add(ch.name);
      }
    }
    advice.push({
      id: 'sample-rate',
      severity: 'important',
      title: `Sampling at ${slowest.toFixed(1)} Hz — too coarse for high-rpm work`,
      detail:
        `The slowest log runs at ${slowest.toFixed(1)} Hz, about ` +
        `${(1000 / slowest).toFixed(0)} ms between samples. A third-gear pull from 3000 to ` +
        '6500 rpm takes roughly four seconds, which at this rate is only a couple of dozen ' +
        'samples across the entire rev range. ' +
        (deadRequests.size > 0
          ? `${deadRequests.size} requested channels return nothing at all ` +
            `(${[...deadRequests].slice(0, 6).join(', ')}${deadRequests.size > 6 ? ', …' : ''}). ` +
            'Every request costs a round trip to the ECU whether or not it answers, so ' +
            'removing the dead ones is close to free speed.'
          : 'Removing channels you are not actively using is the simplest way to speed it up.'),
      unlocks: 'Enough resolution to tune timing and fuelling at high rpm.',
    });
  }

  // --- channels that cannot answer on this car ----------------------------

  const sstDead = IRRELEVANT_ON_5MT.filter(emptyEverywhere);
  if (sstDead.length >= 4) {
    advice.push({
      id: 'sst-channels',
      severity: 'minor',
      title: `${sstDead.length} dual-clutch transmission channels on a manual car`,
      detail:
        `${sstDead.join(', ')} are all empty in every log. These are TC-SST requests, and the ` +
        'ROM identifies this car as a 5MT, so they can never return data. They are pure ' +
        'overhead on every sample.',
      unlocks: 'A faster sample rate at no cost.',
    });
  }

  const naDead = IRRELEVANT_ON_NA.filter(emptyEverywhere);
  if (naDead.length > 0) {
    advice.push({
      id: 'na-channels',
      severity: 'minor',
      title: `${naDead.join(' and ')} requested on a naturally aspirated engine`,
      detail:
        `${naDead.join(' and ')} return nothing, which is expected without a turbo. Worth ` +
        'dropping now and adding back if the car is ever boosted.',
      unlocks: 'A faster sample rate at no cost.',
    });
  }

  // --- fuelling feedback --------------------------------------------------

  const feedback = inputs.map((i) => fuelFeedback(i.log, i.health));
  const bestSource = feedback.some((f) => f.source === 'trims')
    ? 'trims'
    : feedback.some((f) => f.source === 'wideband')
      ? 'wideband'
      : 'none';

  if (bestSource === 'none') {
    advice.push({
      id: 'no-feedback',
      severity: 'blocking',
      title: 'Nothing in these logs measures fuelling error',
      detail:
        'MAF scaling needs either the ECU\'s own fuel trims or a wideband logged against ' +
        'Target_AFR. Without one of those there is no measurement to correct against, and any ' +
        'number produced would be invented.',
      unlocks: 'MAF scaling and the AFR diagnosis.',
    });
  } else if (emptyEverywhere('STFT')) {
    const usingShort = feedback.some((f) => f.channels.some((c) => c.startsWith('STFT')));
    advice.push({
      id: 'stft',
      severity: usingShort ? 'minor' : 'important',
      title: 'STFT returns nothing — the MUT request id is likely wrong',
      detail:
        'The STFT column exists but is empty in every log' +
        (usingShort
          ? ', though STFT#2 is answering, so short-term trim is covered by that request instead.'
          : '. Short-term trim is what shows fuelling error moment to moment; without it only ' +
            'the long-term trim, which updates slowly, is available.'),
      unlocks: 'Faster, finer MAF correction from ordinary cruising.',
    });
  }

  // --- broken sensors -----------------------------------------------------

  for (const [name, why, unlocks] of [
    ['IAT', 'Intake air temperature is pinned at its minimum in every log, which is a dead ' +
      'sensor or a wrong MUT request rather than a real reading.',
      'Air-temperature compensation, and knowing whether a hot day explains a knock event.'],
    ['MAT', 'Manifold air temperature reads in the hundreds, which is raw counts rather than ' +
      'degrees — the scaling in the logger profile does not match what the ECU returns.',
      'A usable second air temperature.'],
    ['Cooltemp', 'Coolant temperature never rises while the engine is running in the drive ' +
      'logs, though it warms normally in the idle log. That points at a different MUT request ' +
      'being used between profiles.',
      'The warm-engine filter, so cold-engine samples stop contaminating timing analysis.'],
  ] as const) {
    if (anyOf((i) => dead(i, name))) {
      advice.push({
        id: `sensor-${name}`,
        severity: name === 'Cooltemp' ? 'important' : 'minor',
        title: `${name} is not returning usable values`,
        detail: why,
        unlocks,
      });
    }
  }

  if (emptyEverywhere('IPW') || anyOf((i) => dead(i, 'IPW'))) {
    advice.push({
      id: 'ipw',
      severity: 'minor',
      title: 'Injector pulse width reads zero',
      detail:
        'IPW sits at zero throughout, so it is not answering. It is the most direct measure of ' +
        'how much fuel is actually being commanded.',
      unlocks: 'Cross-checking fuelling against commanded pulse width, and spotting injectors ' +
        'running out of duty cycle.',
    });
  }

  // --- coverage -----------------------------------------------------------

  let maxLoad = 0;
  let maxRpm = 0;
  for (const i of inputs) {
    const load = i.log.byName.get('Load');
    const rpm = i.log.byName.get('RPM');
    if (load && Number.isFinite(load.max)) maxLoad = Math.max(maxLoad, load.max);
    if (rpm && Number.isFinite(rpm.max)) maxRpm = Math.max(maxRpm, rpm.max);
  }
  if (maxLoad > 0 && maxLoad < 70) {
    advice.push({
      id: 'coverage-load',
      severity: 'important',
      title: `Nothing logged above ${maxLoad.toFixed(0)} Ev% load`,
      detail:
        `The highest load in any log is ${maxLoad.toFixed(0)} Ev%, and rpm peaks at ` +
        `${maxRpm.toFixed(0)}. The top half of every map is therefore unmeasured, and no ` +
        'analysis can say anything about it. A few third-gear pulls from about 2500 rpm to ' +
        'redline, at full throttle, covers it.',
      unlocks: 'Timing and fuelling suggestions for the region that actually makes power — ' +
        'and where getting it wrong does damage.',
    });
  }

  const order: Record<AdviceSeverity, number> = { blocking: 0, important: 1, minor: 2 };
  return advice.sort((a, b) => order[a.severity] - order[b.severity]);
}
