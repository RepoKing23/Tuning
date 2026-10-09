import type { LogFile } from '../log/types';
import { isPlausible } from '../log/channelMeta';
import { median } from '../tune/binning';

/**
 * Virtual dyno: wheel horsepower and torque from a road datalog.
 *
 * A Dynojet measures how fast the car spins a drum of known inertia. On the
 * road the car itself is the inertia: if you know its mass and how fast it is
 * gaining speed, F = m·a gives the force at the tyres, and adding back what
 * aero drag and rolling resistance took gives the force the engine made. Power
 * is that force times road speed.
 *
 * Road speed is not taken from the Speed channel. EvoScan logs it in whole
 * km/h and it updates slowly, so differentiating it gives a curve made of
 * steps. In one gear, road speed is RPM divided by a fixed ratio, and RPM is
 * logged far more finely, so the ratio is measured once per pull and RPM does
 * the rest.
 *
 * Like a Dynojet, this reads at the wheels and does not see the power spent
 * spinning up the engine and gearbox, so the numbers are comparable with a
 * Dynojet sheet rather than with a manufacturer's crank figure.
 */

export interface VehicleSpec {
  /** Car plus driver, passengers and fuel, kg. */
  massKg: number;
  /** Drag coefficient. */
  cd: number;
  /** Frontal area, m². */
  frontalAreaM2: number;
  /** Rolling resistance coefficient. */
  crr: number;
  /** Share of crank power lost in the drivetrain, percent. Only used for the crank estimate. */
  drivetrainLossPct: number;
}

/** Lancer (CY) with a driver on board. Change them for your car. */
export const DEFAULT_VEHICLE: VehicleSpec = {
  massKg: 1430,
  cd: 0.32,
  frontalAreaM2: 2.2,
  crr: 0.013,
  drivetrainLossPct: 15,
};

export interface DynoOptions {
  /** Throttle at or above this counts as a pull. null picks it from the log. */
  minThrottle: number | null;
  /** Half-width, seconds, of the window the RPM slope is fitted over. */
  smoothingSeconds: number;
  /** A pull must cover at least this many rpm to be kept. */
  minRpmSpan: number;
}

export const DEFAULT_DYNO_OPTIONS: DynoOptions = {
  minThrottle: null,
  smoothingSeconds: 1.0,
  minRpmSpan: 1000,
};

export interface DynoPoint {
  time: number;
  rpm: number;
  speedKmh: number;
  /** Wheel power, kW. */
  powerKw: number;
  /** Wheel power expressed as torque at engine rpm, N·m — what a Dynojet sheet plots. */
  torqueNm: number;
}

export interface DynoPull {
  id: string;
  logId: string;
  logName: string;
  startTime: number;
  endTime: number;
  rpmStart: number;
  rpmEnd: number;
  /** Engine rpm per km/h in this gear. */
  rpmPerKmh: number;
  points: DynoPoint[];
  peakPowerKw: number;
  peakPowerRpm: number;
  peakTorqueNm: number;
  peakTorqueRpm: number;
  warnings: string[];
}

export interface DynoResult {
  status: 'ok' | 'blocked';
  message: string;
  notes: string[];
  pulls: DynoPull[];
}

const G = 9.81;
/** Sea-level air at about 20 °C, kg/m³. */
const AIR_DENSITY = 1.2;
/** A shift drops rpm by hundreds; sensor jitter never does this. */
const SHIFT_DROP_RPM = 150;
/** Samples whose rpm/speed ratio strays further than this are not in the pull's gear. */
const GEAR_TOLERANCE = 0.12;
/** Below this, 1 km/h of speed resolution is too coarse to measure the gear ratio. */
const RATIO_MIN_SPEED = 20;
const MIN_PULL_SECONDS = 1.5;
const MIN_POINTS = 5;

export const KW_PER_HP = 0.7457;
export const LBFT_PER_NM = 0.737562;

export function toHp(kw: number): number { return kw / KW_PER_HP; }
export function toLbFt(nm: number): number { return nm * LBFT_PER_NM; }

/** Crank power from wheel power, given drivetrain loss. */
export function crankFromWheel(wheel: number, lossPct: number): number {
  return wheel / (1 - Math.min(60, Math.max(0, lossPct)) / 100);
}

interface Sample { i: number; t: number; rpm: number; speed: number }

/**
 * Local linear regression of rpm against time: the value and slope at `t`.
 * A straight line fitted over a short window is what keeps 1-rpm jitter from
 * turning into a spiky power trace, without flattening the curve's shape.
 */
function localFit(s: Sample[], t: number, half: number): { rpm: number; slope: number; n: number } {
  // Tricube weights (LOESS): near samples count most, so the window can be
  // wide enough to average out rpm's 31-rpm logging steps without the ends of
  // the window dragging the slope toward a different part of the pull.
  let n = 0, before = 0, after = 0, sw = 0, st = 0, sr = 0, stt = 0, str = 0;
  for (const p of s) {
    const dt = p.t - t;
    const u = Math.abs(dt) / half;
    if (u >= 1) continue;
    const w = (1 - u * u * u) ** 3;
    if (dt < 0) before++;
    if (dt > 0) after++;
    n++; sw += w; st += w * dt; sr += w * p.rpm; stt += w * dt * dt; str += w * dt * p.rpm;
  }
  // A one-sided window extrapolates the slope, and at the end of a pull that
  // reads as a spike of power that was never there. Leave those points out.
  if (n < 3 || before < 2 || after < 2) return { rpm: NaN, slope: NaN, n };
  const denom = sw * stt - st * st;
  if (denom <= 1e-12) return { rpm: NaN, slope: NaN, n };
  const slope = (sw * str - st * sr) / denom;
  const intercept = (sr - slope * st) / sw;
  return { rpm: intercept, slope, n };
}

/** Split a log into full-throttle runs, then split each run at gear changes. */
function findRuns(log: LogFile, threshold: number): Sample[][] {
  const rpm = log.byName.get('RPM')!.values;
  const speed = log.byName.get('Speed')!.values;
  const tps = log.byName.get('TPS')!.values;

  const runs: Sample[][] = [];
  let cur: Sample[] = [];
  const close = () => { if (cur.length) runs.push(cur); cur = []; };

  for (let i = 0; i < log.rowCount; i++) {
    const r = rpm[i], v = speed[i], th = tps[i];
    const usable =
      isPlausible('RPM', r) && isPlausible('Speed', v) && isPlausible('TPS', th) &&
      th >= threshold && v >= 5 && r > 0;
    if (!usable) { close(); continue; }
    const prev = cur[cur.length - 1];
    if (prev && prev.rpm - r > SHIFT_DROP_RPM) close();
    cur.push({ i, t: log.time[i], rpm: r, speed: v });
  }
  close();
  return runs;
}

/** Drop the run's tail once rpm stops climbing (rev limiter, lift, or wheelspin ending). */
function trimToClimb(run: Sample[]): Sample[] {
  let peak = 0;
  for (let k = 1; k < run.length; k++) if (run[k].rpm >= run[peak].rpm) peak = k;
  return run.slice(0, peak + 1);
}

function autoThreshold(log: LogFile): number {
  const tps = log.byName.get('TPS')!.values;
  let max = -Infinity;
  for (let i = 0; i < tps.length; i++) if (isPlausible('TPS', tps[i]) && tps[i] > max) max = tps[i];
  // Many drive-by-wire cars never report 100 %: the pedal's top is the real WOT.
  return Number.isFinite(max) ? max * 0.95 : NaN;
}

function analysePull(
  log: LogFile, run: Sample[], index: number, vehicle: VehicleSpec, opts: DynoOptions,
): DynoPull | { rejected: string } {
  const where = `${log.name} at ${run[0].t.toFixed(1)}s`;

  const ratioSamples = run.filter((s) => s.speed >= RATIO_MIN_SPEED);
  const basis = ratioSamples.length >= 3 ? ratioSamples : run;
  const k = median(basis.map((s) => s.rpm / s.speed));
  if (!Number.isFinite(k) || k <= 0) return { rejected: `${where}: could not measure the gear ratio` };

  const inGear = basis.filter((s) => Math.abs(s.rpm / s.speed / k - 1) <= GEAR_TOLERANCE);
  if (inGear.length < basis.length * 0.75) {
    return {
      rejected: `${where}: rpm and road speed do not move together, so it is not one gear ` +
        '(a shift, clutch slip or wheelspin)',
    };
  }

  const half = Math.max(0.1, opts.smoothingSeconds);
  const rho = AIR_DENSITY;
  const m = vehicle.massKg;
  const points: DynoPoint[] = [];
  for (const s of run) {
    const fit = localFit(run, s.t, half);
    if (!Number.isFinite(fit.rpm) || fit.rpm <= 0) continue;
    const v = fit.rpm / k / 3.6; // m/s
    const a = fit.slope / k / 3.6; // m/s²
    const force = m * a + 0.5 * rho * vehicle.cd * vehicle.frontalAreaM2 * v * v + vehicle.crr * m * G;
    const powerW = force * v;
    const omega = (fit.rpm * 2 * Math.PI) / 60;
    points.push({
      time: s.t,
      rpm: fit.rpm,
      speedKmh: v * 3.6,
      powerKw: powerW / 1000,
      torqueNm: powerW / omega,
    });
  }
  if (points.length < MIN_POINTS) return { rejected: `${where}: too few samples to fit a curve` };

  let pp = points[0], pt = points[0];
  for (const p of points) {
    if (p.powerKw > pp.powerKw) pp = p;
    if (p.torqueNm > pt.torqueNm) pt = p;
  }

  const warnings: string[] = [];
  const span = run[run.length - 1].rpm - run[0].rpm;
  if (span < 1500) {
    warnings.push(`Covers only ${span.toFixed(0)} rpm, so the true peak may lie outside it.`);
  }
  if (pp === points[points.length - 1]) {
    warnings.push('Power was still rising when the pull ended; the peak is probably higher.');
  }
  if (points.some((p) => p.powerKw < 0)) {
    warnings.push('Part of the pull reads negative power — likely downhill, braking or a throttle lift.');
  }

  return {
    id: `${log.id}#${index}`,
    logId: log.id,
    logName: log.name,
    startTime: run[0].t,
    endTime: run[run.length - 1].t,
    rpmStart: run[0].rpm,
    rpmEnd: run[run.length - 1].rpm,
    rpmPerKmh: k,
    points,
    peakPowerKw: pp.powerKw,
    peakPowerRpm: pp.rpm,
    peakTorqueNm: pt.torqueNm,
    peakTorqueRpm: pt.rpm,
    warnings,
  };
}

/** Find every full-throttle pull in the logs and put each on the virtual dyno. */
export function runDyno(
  logs: LogFile[], vehicle: VehicleSpec = DEFAULT_VEHICLE, opts: DynoOptions = DEFAULT_DYNO_OPTIONS,
): DynoResult {
  if (logs.length === 0) {
    return { status: 'blocked', message: 'No logs selected. Tick at least one in the Files panel.', notes: [], pulls: [] };
  }
  if (!(vehicle.massKg > 0)) {
    return { status: 'blocked', message: 'Enter the car\'s weight — power is mass times acceleration.', notes: [], pulls: [] };
  }

  const notes: string[] = [];
  const pulls: DynoPull[] = [];
  let usableLogs = 0;

  for (const log of logs) {
    const missing = ['RPM', 'Speed', 'TPS'].filter((c) => !log.byName.get(c)?.n);
    if (missing.length) {
      notes.push(`${log.name}: skipped — ${missing.join(', ')} not logged.`);
      continue;
    }
    usableLogs++;

    const threshold = opts.minThrottle ?? autoThreshold(log);
    if (!Number.isFinite(threshold) || threshold < 40) {
      notes.push(`${log.name}: throttle never went past ${threshold.toFixed(0)}%, so there is no full-throttle pull.`);
      continue;
    }

    let index = 0;
    for (const raw of findRuns(log, threshold)) {
      const run = trimToClimb(raw);
      if (run.length < MIN_POINTS) continue;
      const span = run[run.length - 1].rpm - run[0].rpm;
      const secs = run[run.length - 1].t - run[0].t;
      if (span < opts.minRpmSpan || secs < MIN_PULL_SECONDS) continue;
      const result = analysePull(log, run, index++, vehicle, opts);
      if ('rejected' in result) notes.push(result.rejected);
      else pulls.push(result);
    }

    if (log.sampleInterval > 0.15) {
      notes.push(
        `${log.name} was logged at about ${(1 / log.sampleInterval).toFixed(0)} samples/s. ` +
        'Logging fewer channels raises the rate, and a faster log gives a sharper curve.',
      );
    }
  }

  if (usableLogs === 0) {
    return { status: 'blocked', message: 'The dyno needs RPM, Speed and TPS in the log.', notes, pulls: [] };
  }
  if (pulls.length === 0) {
    return {
      status: 'blocked',
      message:
        'No full-throttle pull found. Hold full throttle in one gear (3rd or 4th is best) from ' +
        'low rpm to near the redline, on a flat road.',
      notes,
      pulls: [],
    };
  }

  // A slope adds or removes m·g·grade of force, and the power that costs
  // grows with speed. Quote it at the speed the peak was measured.
  const fastest = pulls.reduce((a, b) => (b.peakPowerKw > a.peakPowerKw ? b : a));
  const peakSpeed = fastest.peakPowerRpm / fastest.rpmPerKmh / 3.6;
  const slopeHp = toHp((vehicle.massKg * G * 0.01 * peakSpeed) / 1000);
  notes.push(
    `A road dyno assumes a flat road: a 1% slope moves the peak by about ${slopeHp.toFixed(0)} hp at ` +
    'that speed. Run the same pull in both directions on the same stretch and average them.',
  );
  return {
    status: 'ok',
    message: `Found ${pulls.length} pull${pulls.length === 1 ? '' : 's'}.`,
    notes,
    pulls,
  };
}
