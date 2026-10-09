import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEvoScanCsv } from '../src/lib/log/parseEvoScanCsv';
import {
  crankFromWheel, DEFAULT_DYNO_OPTIONS, DEFAULT_VEHICLE, runDyno, toHp, toLbFt,
} from '../src/lib/dyno/dyno';
import { valueAt } from '../src/components/dyno/DynoChart';

const root = resolve(__dirname, '..');
const load = (file: string) =>
  parseEvoScanCsv(readFileSync(resolve(root, 'samples', file), 'utf8'), file);

const idle = load('log-idle-2026.09.02_13.54.34.csv');
const drive1 = load('log-drive-2026.09.02_14.21.59.csv');
const drive2 = load('log-drive-2026.09.02_14.28.42.csv');

/**
 * A log of a car making exactly `powerKw` at the wheels, integrated forward
 * with the same road-load model, then degraded the way EvoScan degrades a real
 * one: uneven sample spacing, rpm in 31.25-rpm steps and speed in whole km/h.
 */
function syntheticPull(opts: {
  powerKw: number; rpmPerKmh: number; fromRpm: number; toRpm: number;
  thenShiftTo?: number; tps?: number;
}): string {
  const { massKg: m, cd, frontalAreaM2: A, crr } = DEFAULT_VEHICLE;
  const lines = ['LogID,LogEntrySeconds,RPM,Speed,TPS'];
  let v = opts.fromRpm / opts.rpmPerKmh / 3.6;
  let t = 0;
  let id = 1;
  let ratio = opts.rpmPerKmh;
  let shifted = false;
  // Deterministic jitter so the test never flakes.
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  // A second of cruising first, so the pull has a lead-in like a real log.
  for (let k = 0; k < 5; k++) {
    const rpm = v * 3.6 * ratio;
    lines.push(`${id++},${t.toFixed(3)},${Math.round(rpm / 31.25) * 31.25},${Math.round(v * 3.6)},10`);
    t += 0.2;
  }
  for (;;) {
    const dt = 0.18 + rand() * 0.1;
    const drag = 0.5 * 1.2 * cd * A * v * v + crr * m * 9.81;
    const a = (opts.powerKw * 1000 / v - drag) / m;
    v += a * dt;
    t += dt;
    let rpm = v * 3.6 * ratio;
    if (rpm >= opts.toRpm) {
      if (!opts.thenShiftTo || shifted) break;
      ratio = opts.thenShiftTo;
      shifted = true;
      rpm = v * 3.6 * ratio;
    }
    lines.push(
      `${id++},${t.toFixed(3)},${Math.round(rpm / 31.25) * 31.25},${Math.round(v * 3.6)},${opts.tps ?? 100}`,
    );
  }
  return lines.join('\n');
}

describe('virtual dyno — physics', () => {
  it('recovers a known wheel power from a quantised, unevenly sampled log', () => {
    const log = parseEvoScanCsv(
      syntheticPull({ powerKw: 90, rpmPerKmh: 47.6, fromRpm: 2500, toRpm: 6000 }), 'synthetic.csv',
    );
    const r = runDyno([log]);
    expect(r.status).toBe('ok');
    expect(r.pulls).toHaveLength(1);
    const pull = r.pulls[0];
    expect(pull.rpmPerKmh).toBeCloseTo(47.6, 0);

    // Away from the ends, where the smoothing window is one-sided.
    const middle = pull.points.filter((p) => p.rpm > 3000 && p.rpm < 5500);
    expect(middle.length).toBeGreaterThan(10);
    for (const p of middle) expect(p.powerKw).toBeGreaterThan(90 * 0.9);
    for (const p of middle) expect(p.powerKw).toBeLessThan(90 * 1.1);
    const mean = middle.reduce((s, p) => s + p.powerKw, 0) / middle.length;
    expect(mean).toBeCloseTo(90, -1);
  });

  it('reports torque as wheel power at engine rpm, as a Dynojet sheet does', () => {
    const log = parseEvoScanCsv(
      syntheticPull({ powerKw: 90, rpmPerKmh: 47.6, fromRpm: 2500, toRpm: 6000 }), 'synthetic.csv',
    );
    for (const p of runDyno([log]).pulls[0].points) {
      // hp × 5252 / rpm = lb·ft is the sheet's definition.
      expect(toLbFt(p.torqueNm)).toBeCloseTo((toHp(p.powerKw) * 5252.1) / p.rpm, 0);
    }
  });

  it('scales with the mass it is told, since power is mass times acceleration', () => {
    const log = parseEvoScanCsv(
      syntheticPull({ powerKw: 90, rpmPerKmh: 47.6, fromRpm: 2500, toRpm: 6000 }), 'synthetic.csv',
    );
    const light = runDyno([log], DEFAULT_VEHICLE).pulls[0].peakPowerKw;
    const heavy = runDyno([log], { ...DEFAULT_VEHICLE, massKg: DEFAULT_VEHICLE.massKg * 1.1 }).pulls[0].peakPowerKw;
    expect(heavy).toBeGreaterThan(light * 1.05);
  });

  it('splits at a gear change instead of reading the rpm drop as negative power', () => {
    const log = parseEvoScanCsv(
      syntheticPull({ powerKw: 90, rpmPerKmh: 64, fromRpm: 2500, toRpm: 6000, thenShiftTo: 47.6 }),
      'shift.csv',
    );
    const r = runDyno([log]);
    expect(r.pulls.length).toBe(2);
    expect(r.pulls[0].rpmPerKmh).toBeCloseTo(64, 0);
    expect(r.pulls[1].rpmPerKmh).toBeCloseTo(47.6, 0);
    for (const pull of r.pulls) {
      for (const p of pull.points) expect(p.powerKw).toBeGreaterThan(0);
    }
  });

  it('treats the top of a drive-by-wire pedal as full throttle', () => {
    const log = parseEvoScanCsv(
      syntheticPull({ powerKw: 90, rpmPerKmh: 47.6, fromRpm: 2500, toRpm: 6000, tps: 80 }), 'dbw.csv',
    );
    expect(runDyno([log]).pulls).toHaveLength(1);
    // Asking for a real 90% excludes it.
    expect(runDyno([log], DEFAULT_VEHICLE, { ...DEFAULT_DYNO_OPTIONS, minThrottle: 90 }).pulls).toHaveLength(0);
  });

  it('adds drivetrain loss back for the crank estimate', () => {
    expect(crankFromWheel(85, 15)).toBeCloseTo(100, 6);
    expect(crankFromWheel(100, 0)).toBe(100);
  });
});

describe('virtual dyno — sample logs', () => {
  it('finds the full-throttle pulls in the drive logs and none in the idle log', () => {
    const r = runDyno([drive1, drive2]);
    expect(r.status).toBe('ok');
    expect(r.pulls.length).toBe(3);
    expect(runDyno([idle]).status).toBe('blocked');
  });

  it('measures one consistent gear ratio for pulls in the same gear', () => {
    const ratios = runDyno([drive1, drive2]).pulls.map((p) => p.rpmPerKmh);
    for (const k of ratios) expect(k).toBeGreaterThan(46);
    for (const k of ratios) expect(k).toBeLessThan(49);
  });

  it('gives numbers in the range a naturally aspirated 2.0 makes at the wheels', () => {
    for (const p of runDyno([drive1, drive2]).pulls) {
      expect(toHp(p.peakPowerKw)).toBeGreaterThan(60);
      expect(toHp(p.peakPowerKw)).toBeLessThan(160);
      expect(p.peakPowerRpm).toBeGreaterThanOrEqual(p.rpmStart);
      expect(p.peakPowerRpm).toBeLessThanOrEqual(p.rpmEnd + 50);
    }
  });

  it('warns about the slow sample rate and the road slope', () => {
    const r = runDyno([drive1]);
    expect(r.notes.some((n) => n.includes('samples/s'))).toBe(true);
    expect(r.notes.some((n) => n.includes('1% slope'))).toBe(true);
  });

  it('refuses without a weight, and without the channels it needs', () => {
    expect(runDyno([drive1], { ...DEFAULT_VEHICLE, massKg: 0 }).status).toBe('blocked');
    const noTps = parseEvoScanCsv('LogEntrySeconds,RPM,Speed\n0,3000,60\n0.2,3100,62', 'x.csv');
    const r = runDyno([noTps]);
    expect(r.status).toBe('blocked');
    expect(r.notes[0]).toContain('TPS');
  });
});

describe('dyno chart helpers', () => {
  it('interpolates between points and is NaN outside the pull', () => {
    const pts = [{ x: 3000, y: 50 }, { x: 4000, y: 70 }];
    expect(valueAt(pts, 3500)).toBe(60);
    expect(valueAt(pts, 2900)).toBeNaN();
    expect(valueAt(pts, 4100)).toBeNaN();
  });
});
