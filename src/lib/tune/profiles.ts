/**
 * Tune personalities.
 *
 * Every constant here is a conservative default for a naturally aspirated 4B11
 * on pump fuel, not a measured value for your engine. They are deliberately
 * timid: the recommender's job is to move the tune in the right direction with
 * evidence behind each step, not to find the last degree.
 */

export type ProfileId = 'eco' | 'power' | 'popsAndBangs' | 'flames';

/**
 * The rectangle of the spark map an overrun profile works on, in axis units.
 *
 * Which cells the engine passes through on a closed throttle depends on the
 * car — gearing, exhaust, how you drive — so this is a choice rather than a
 * constant. Bounds are inclusive and snap to the table's own breakpoints in the
 * UI, so a window always names whole cells.
 */
export interface OverrunWindow {
  rpmMin: number;
  rpmMax: number;
  loadMin: number;
  loadMax: number;
}

export function inWindow(w: OverrunWindow, rpm: number, load: number): boolean {
  return rpm >= w.rpmMin && rpm <= w.rpmMax && load >= w.loadMin && load <= w.loadMax;
}

const nearest = (axis: number[], v: number): number =>
  axis.length === 0
    ? v
    : axis.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), axis[0]);

/**
 * Move a window's bounds onto the table's own breakpoints.
 *
 * A default like "load from 0" is a convenient way to say "from the bottom",
 * but a bound that sits between cells cannot be shown in a picker that lists
 * real axis values. Snapping keeps what the user sees and what the engine
 * applies identical.
 */
export function snapWindow(w: OverrunWindow, rpmAxis: number[], loadAxis: number[]): OverrunWindow {
  return {
    rpmMin: nearest(rpmAxis, w.rpmMin),
    rpmMax: nearest(rpmAxis, w.rpmMax),
    loadMin: nearest(loadAxis, w.loadMin),
    loadMax: nearest(loadAxis, w.loadMax),
  };
}

export interface Profile {
  id: ProfileId;
  label: string;
  description: string;
  /** Shown persistently in the UI when the profile carries real risk. */
  warning?: string;
  /** Largest advance this profile will ever add to one cell, in degrees. */
  maxAdvance: number;
  /** Largest retard a knock event may pull from one cell, in degrees. */
  maxKnockRetard: number;
  /**
   * Absolute timing the overrun cells are driven to, in degrees. Negative means
   * after TDC.
   *
   * Overrun profiles must set an absolute target rather than subtract a fixed
   * amount, because the stock map holds 28-45 degrees of advance in this region
   * and no bounded subtraction from that reaches the wrong side of TDC. Burning
   * fuel in the exhaust requires the charge to still be alight when the exhaust
   * valve opens, which does not happen at any positive advance.
   */
  overrunTargetDeg?: number;
  /** Scales every suggested step. 1.0 is the profile's full nominal step. */
  aggression: number;
  /** Cells the profile wants to change. Unused by overrun profiles. */
  region: (rpm: number, load: number) => boolean;
  /**
   * Starting overrun window, which the user can move. Idle is deliberately
   * excluded: retarding it past TDC stalls the engine.
   */
  defaultWindow?: OverrunWindow;
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
    maxKnockRetard: 4,
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
    maxKnockRetard: 6,
    aggression: 0.6,
    region: (rpm, load) => load >= 50 && rpm >= 2000,
    overrun: false,
  },
  popsAndBangs: {
    id: 'popsAndBangs',
    label: 'Pops & bangs',
    description:
      'Drives the closed-throttle overrun cells to about 10 degrees after TDC, so the charge ' +
      'is still burning when the exhaust valve opens. Needs the decel fuel-cut tables ' +
      'softened too — see the notes below.',
    warning:
      'This burns fuel in the exhaust on every lift. It destroys catalytic converters and, ' +
      'run hard or for long, damages exhaust valves and turbine housings. Expect to fail an ' +
      'emissions test.',
    maxAdvance: 0,
    maxKnockRetard: 12,
    overrunTargetDeg: -10,
    aggression: 1,
    region: (rpm, load) => load <= 20 && rpm >= 1500 && rpm <= 4500,
    defaultWindow: { rpmMin: 1500, rpmMax: 4500, loadMin: 0, loadMax: 20 },
    overrun: true,
  },
  flames: {
    id: 'flames',
    label: 'Flames',
    description:
      'The same overrun mechanism as pops & bangs, taken further: about 20 degrees after TDC ' +
      'across a wider rpm band, with the fuel cut delayed longer.',
    warning:
      'Substantially more damaging than pops & bangs. Unburnt fuel igniting in the exhaust ' +
      'will destroy a catalytic converter quickly and can crack a manifold, burn exhaust ' +
      'valves, and melt a turbine housing. Use only on a decatted car you are prepared to ' +
      'rebuild, and never for extended periods.',
    maxAdvance: 0,
    maxKnockRetard: 20,
    overrunTargetDeg: -20,
    aggression: 1,
    region: (rpm, load) => load <= 30 && rpm >= 1500,
    defaultWindow: { rpmMin: 1500, rpmMax: 6500, loadMin: 0, loadMax: 30 },
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
