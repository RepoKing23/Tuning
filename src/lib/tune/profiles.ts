/**
 * Tune personalities.
 *
 * Every constant here is a conservative default for a naturally aspirated 4B11
 * on pump fuel, not a measured value for your engine. They are deliberately
 * timid: the recommender's job is to move the tune in the right direction with
 * evidence behind each step, not to find the last degree.
 */

export type ProfileId = 'eco' | 'power' | 'popsAndBangs' | 'flames';

export interface Profile {
  id: ProfileId;
  label: string;
  description: string;
  /** Shown persistently in the UI when the profile carries real risk. */
  warning?: string;
  /** Largest advance this profile will ever add to one cell, in degrees. */
  maxAdvance: number;
  /** Largest retard this profile will ever apply to one cell, in degrees. */
  maxRetard: number;
  /** Scales every suggested step. 1.0 is the profile's full nominal step. */
  aggression: number;
  /** Cells the profile wants to change. */
  region: (rpm: number, load: number) => boolean;
  /** True when the profile works on overrun cells rather than driven ones. */
  overrun: boolean;
}

export const PROFILES: Record<ProfileId, Profile> = {
  eco: {
    id: 'eco',
    label: 'Economy',
    description:
      'Adds timing in the light-load cruise region only, where extra advance improves ' +
      'efficiency, and leaves everything above half load exactly as it is.',
    maxAdvance: 3,
    maxRetard: 4,
    aggression: 0.7,
    region: (rpm, load) => load <= 50 && rpm >= 1250 && rpm <= 3500,
    overrun: false,
  },
  power: {
    id: 'power',
    label: 'Power',
    description:
      'Works the mid- and high-load cells toward best torque, backing off immediately ' +
      'wherever the logs recorded knock.',
    maxAdvance: 2,
    maxRetard: 6,
    aggression: 0.6,
    region: (rpm, load) => load >= 50 && rpm >= 2000,
    overrun: false,
  },
  popsAndBangs: {
    id: 'popsAndBangs',
    label: 'Pops & bangs',
    description:
      'Retards ignition on closed-throttle overrun so combustion finishes in the exhaust. ' +
      'Needs the decel fuel-cut tables softened too — see the notes below.',
    warning:
      'This burns fuel in the exhaust on every lift. It destroys catalytic converters and, ' +
      'run hard or for long, damages exhaust valves and turbine housings. Expect to fail an ' +
      'emissions test.',
    maxAdvance: 0,
    maxRetard: 12,
    aggression: 0.5,
    region: (rpm, load) => load <= 30 && rpm >= 1500 && rpm <= 4500,
    overrun: true,
  },
  flames: {
    id: 'flames',
    label: 'Flames',
    description:
      'The same overrun mechanism as pops & bangs, taken further: more retard across a ' +
      'wider rpm band, with the fuel cut delayed longer.',
    warning:
      'Substantially more damaging than pops & bangs. Unburnt fuel igniting in the exhaust ' +
      'will destroy a catalytic converter quickly and can crack a manifold, burn exhaust ' +
      'valves, and melt a turbine housing. Use only on a decatted car you are prepared to ' +
      'rebuild, and never for extended periods.',
    maxAdvance: 0,
    maxRetard: 20,
    aggression: 0.8,
    region: (rpm, load) => load <= 35 && rpm >= 1500,
    overrun: true,
  },
};

/**
 * Conservative ceiling on total advance against load, in degrees.
 *
 * Interpolated between these breakpoints. Above 100 Ev% the engine is under
 * boost, where the ceiling falls away sharply.
 */
const ADVANCE_CEILING: [load: number, degrees: number][] = [
  [0, 45], [20, 44], [30, 42], [40, 38], [50, 34], [60, 30],
  [70, 26], [80, 22], [90, 18], [100, 15], [150, 11], [260, 8],
];

export function advanceCeiling(load: number): number {
  if (load <= ADVANCE_CEILING[0][0]) return ADVANCE_CEILING[0][1];
  const last = ADVANCE_CEILING[ADVANCE_CEILING.length - 1];
  if (load >= last[0]) return last[1];
  for (let i = 1; i < ADVANCE_CEILING.length; i++) {
    const [x1, y1] = ADVANCE_CEILING[i - 1];
    const [x2, y2] = ADVANCE_CEILING[i];
    if (load <= x2) return y1 + ((y2 - y1) * (load - x1)) / (x2 - x1);
  }
  return last[1];
}

/** Knock counts that justify pulling one degree out of a cell. */
export const KNOCK_PER_DEGREE = 3;

/** Samples in a cell before its statistics mean anything. */
export const MIN_SAMPLES = 12;

/** Samples at which a cell is considered fully sampled (confidence 1.0). */
export const SATURATION_SAMPLES = 80;

/**
 * The decel and fuel-cut tables that actually control overrun fuelling.
 *
 * Spark retard alone makes a soft burble; the crackle comes from fuel still
 * being injected on the overrun, which these tables govern. They are listed
 * rather than edited automatically because their axes and meaning vary, and
 * getting them wrong causes stalling and driveability faults rather than noise.
 */
export const OVERRUN_TABLE_HINTS: { category: string; guidance: string }[] = [
  {
    category: 'THROTTLE DECEL (pre fuel cut)',
    guidance:
      'Raise the rpm thresholds and soften the ramp so the ECU keeps injecting further ' +
      'into the overrun. This is what supplies the fuel that makes the noise.',
  },
  {
    category: 'FUEL CUT',
    guidance:
      'Lower the fuel-cut recovery rpm and delay the cut itself. Small steps: too much ' +
      'here causes surging and hesitation on lift.',
  },
  {
    category: 'THROTTLE DECEL (fuel cut)',
    guidance: 'Controls how abruptly fuel is cut. Softening it lengthens the burble.',
  },
];
