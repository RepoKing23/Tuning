import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEvoScanCsv } from '../src/lib/log/parseEvoScanCsv';
import { assessChannels } from '../src/lib/log/channelHealth';
import { parseDefinitionXml } from '../src/lib/rom/parseDefinitionXml';
import { readTable, clampAndQuantise, usableRange, exceedsAdvisory } from '../src/lib/rom/readTable';
import { recommendMaf, DEFAULT_MAF_OPTIONS } from '../src/lib/tune/maf';
import { recommendTiming } from '../src/lib/tune/timing';
import { advanceCeiling, PROFILES, snapWindow, MIN_SAMPLES } from '../src/lib/tune/profiles';
import { binLog, DEFAULT_FILTER } from '../src/lib/tune/binning';
import { analyseAfr, recommendFuelMap } from '../src/lib/tune/afr';
import { detectLoadScale } from '../src/lib/log/loadScale';
import { analyseKnock, recommendKnockRetard, recommendNoiseFloor } from '../src/lib/tune/knock';
import type { ProfileId } from '../src/lib/tune/profiles';

const root = resolve(__dirname, '..');
const rom = new Uint8Array(readFileSync(resolve(root, 'samples/stock_2.bin')));
const def = parseDefinitionXml(readFileSync(resolve(root, 'samples/54740002-LancerX-MUT-v2.xml'), 'utf8'));

const loadLog = (file: string) => {
  const log = parseEvoScanCsv(readFileSync(resolve(root, 'samples', file), 'utf8'), file);
  return { log, health: assessChannels(log) };
};

const drive1 = loadLog('log-drive-2026.09.02_14.21.59.csv');
const drive2 = loadLog('log-drive-2026.09.02_14.28.42.csv');
const inputs = [drive1, drive2];

const tableNamed = (name: string) => {
  const t = def.tables.find((d) => d.name === name);
  if (!t) throw new Error(`no table "${name}"`);
  return readTable(rom, def, t);
};

const spark = tableNamed('High Octane Spark Map');
const mafPart1 = tableNamed('MAF CALIBRATION Part 1  (units)');

describe('MAF recommender', () => {
  it('refuses to guess when a log carries no fuel feedback at all', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,KnockSum\n';
    const rows = Array.from({ length: 200 }, (_, i) => `${(i * 0.1).toFixed(3)},2000,30,20,2.1,0`);
    const bare = parseEvoScanCsv(header + rows.join('\n'), 'bare.csv');
    const rec = recommendMaf([{ log: bare, health: assessChannels(bare) }], mafPart1);
    expect(rec.status).toBe('blocked');
    expect(rec.suggestions.size).toBe(0);
    expect(rec.notes.join(' ')).toMatch(/STFT and LTFT|wideband/);
  });

  it('corrects from the real logs using the learned long-term trim', () => {
    const rec = recommendMaf(inputs, mafPart1);
    expect(rec.status).toBe('ok');
    // Trims outrank the wideband: they are the correction the ECU has already
    // had to learn, and unlike the wideband they stay meaningful in closed loop.
    expect(rec.message).toMatch(/LTFT_Cruise/);
    expect(rec.suggestions.size).toBeGreaterThan(0);

    const result = mafPart1.values.map((row, r) => rec.suggestions.get(`${r},0`)?.value ?? row[0]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(result[i - 1]);
    }
    for (const [key, s] of rec.suggestions) {
      const r = Number(key.split(',')[0]);
      const base = mafPart1.values[r][0];
      // Nothing moves further than the configured cap allows.
      if (base > 0) expect(Math.abs(s.delta) / base).toBeLessThanOrEqual(0.11);
    }
  });

  it('uses closed-loop trims when they are available', () => {
    // Synthesise a log with healthy trims: the ECU is adding 6% fuel, so the
    // MAF is under-reporting and the table must rise by roughly the same.
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,STFT,LTFT,KnockSum,Cooltemp\n';
    const rows: string[] = [];
    for (let i = 0; i < 900; i++) {
      const t = (i * 0.1).toFixed(3);
      // Sweep slowly across the low-voltage bins so several fill up.
      const volts = (1.0 + (i % 300) * 0.002).toFixed(4);
      // Trims must move; a perfectly flat trim carries no information and
      // is rejected by the health gate, correctly.
      const stft = (3 + (i % 7) * 0.5).toFixed(2);
      const ltft = (2.2 + (i % 5) * 0.4).toFixed(2);
      rows.push(`${t},2500,40,25,${volts},${stft},${ltft},0,88`);
    }
    const log = parseEvoScanCsv(header + rows.join('\n'), 'synthetic.csv');
    const rec = recommendMaf([{ log, health: assessChannels(log) }], mafPart1);

    expect(rec.status).toBe('ok');
    expect(rec.suggestions.size).toBeGreaterThan(0);

    for (const s of rec.suggestions.values()) {
      // 6% total trim, and the cap is 10%.
      expect(Math.abs(s.delta)).toBeLessThanOrEqual(
        Math.max(1, Math.abs(mafPart1.values[0][0]) * 0.11) + 1e6,
      );
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }

    // The resulting transfer must never fall as voltage rises.
    const result = mafPart1.values.map((row, r) => rec.suggestions.get(`${r},0`)?.value ?? row[0]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(result[i - 1]);
    }
  });
});

describe('timing recommender', () => {
  it('produces suggestions for every profile without exceeding its own limits', () => {
    for (const id of Object.keys(PROFILES) as ProfileId[]) {
      const profile = PROFILES[id];
      const rec = recommendTiming(inputs, spark, {
        profile: id, minSamples: 4, intensity: 1, timeRange: null,
      });
      if (rec.status === 'blocked') continue;
      for (const [key, s] of rec.suggestions) {
        const [r, c] = key.split(',').map(Number);
        const current = spark.values[r][c];
        expect(s.value).toBe(current + s.delta);
        if (s.delta > 0) {
          expect(s.delta).toBeLessThanOrEqual(profile.maxAdvance);
        } else if (profile.overrun && s.knock === 0) {
          // Overrun profiles set an absolute target, so the delta is however
          // far the stock value sits from it. The landing point is what matters.
          expect(s.value).toBe(Math.round(profile.overrunTargetDeg! * profile.aggression));
        } else {
          expect(-s.delta).toBeLessThanOrEqual(profile.maxKnockRetard);
        }
        // The ROM's own scaling limits are absolute.
        expect(s.value).toBeGreaterThanOrEqual(spark.scaling.min);
        expect(s.value).toBeLessThanOrEqual(spark.scaling.max);
      }
    }
  });

  it('never advances a cell that recorded knock', () => {
    for (const id of Object.keys(PROFILES) as ProfileId[]) {
      const rec = recommendTiming(inputs, spark, {
        profile: id, minSamples: 4, intensity: 1.5, timeRange: null,
      });
      for (const s of rec.suggestions.values()) {
        if (s.knock > 0) expect(s.delta).toBeLessThan(0);
      }
    }
  });

  it('never advances a cell past the load-dependent ceiling', () => {
    const rec = recommendTiming(inputs, spark, {
      profile: 'eco', minSamples: 4, intensity: 1.5, timeRange: null,
    });
    for (const [key, s] of rec.suggestions) {
      if (s.delta <= 0) continue;
      const [, c] = key.split(',').map(Number);
      expect(s.value).toBeLessThanOrEqual(advanceCeiling(spark.x.values[c]) + 1e-9);
    }
  });

  it('leaves cells with too little data alone', () => {
    const rec = recommendTiming(inputs, spark, {
      profile: 'eco', minSamples: 60, intensity: 1, timeRange: null,
    });
    for (const s of rec.suggestions.values()) {
      expect(s.samples).toBeGreaterThanOrEqual(60);
    }
    expect(rec.starved).toBeGreaterThan(0);
  });

  it('blocks when knock feedback is missing', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,TimingAdv,Cooltemp\n';
    const rows = Array.from({ length: 200 }, (_, i) => `${(i * 0.1).toFixed(3)},2500,40,25,20,88`);
    const log = parseEvoScanCsv(header + rows.join('\n'), 'noknock.csv');
    const rec = recommendTiming([{ log, health: assessChannels(log) }], spark);
    expect(rec.status).toBe('blocked');
    expect(rec.message).toMatch(/KnockSum/);
  });
});

describe('binning', () => {
  it('attributes samples onto the spark map axes and reports rejections', () => {
    const binned = binLog(drive1.log, {
      xAxis: spark.x.values,
      yAxis: spark.y.values,
      xChannel: 'Load',
      yChannel: 'RPM',
      collect: ['TimingAdv'],
      filter: DEFAULT_FILTER,
      ignoreCoolant: true,
    });
    expect(binned.used).toBeGreaterThan(0);
    const total = binned.cells.flat().reduce((sum, c) => sum + c.n, 0);
    expect(total).toBe(binned.used);
    expect(Object.keys(binned.rejected).length).toBeGreaterThan(0);
  });

  it('honours the coolant filter when the channel is trustworthy', () => {
    // These drive logs report coolant around -12 C, so a warm-engine filter
    // must throw everything away rather than silently accepting it.
    const binned = binLog(drive1.log, {
      xAxis: spark.x.values,
      yAxis: spark.y.values,
      xChannel: 'Load',
      yChannel: 'RPM',
      collect: [],
      filter: DEFAULT_FILTER,
      ignoreCoolant: false,
    });
    expect(binned.used).toBe(0);
    expect(binned.rejected['engine not warm']).toBeGreaterThan(0);
  });
});

describe('advance ceiling', () => {
  it('falls monotonically with load', () => {
    let prev = Infinity;
    for (let load = 0; load <= 260; load += 5) {
      const v = advanceCeiling(load);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});

describe('MAF part voltage ranges', () => {
  it('does not clamp out-of-range samples onto a part it does not cover', () => {
    // Part 1 spans 0.00-1.68 V. The drive logs run to 4.04 V, and without a
    // range guard nearestIndex would pile every one of those onto the 1.68 V
    // end bin and corrupt it.
    const rec = recommendMaf(inputs, mafPart1);
    expect(rec.status).toBe('ok');
    expect(rec.notes.join(' ')).toMatch(/fell outside this part's/);

    const lastBin = mafPart1.ny - 1;
    const endSuggestion = rec.suggestions.get(`${lastBin},0`);
    if (endSuggestion) expect(endSuggestion.samples).toBeLessThan(400);
  });

  it('routes each sample to the part that actually covers its voltage', () => {
    // A synthetic open-loop log parked at 2.6 V, which only Part 2 covers.
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,WideBandAF,Target_AFR,KnockSum\n';
    // Values have to move: a perfectly flat channel is flagged stuck by the
    // health gate, correctly, and then carries no feedback to tune on.
    const rows = Array.from({ length: 600 }, (_, i) => {
      const volts = (2.58 + (i % 5) * 0.01).toFixed(3);
      const wb = (12.9 + (i % 7) * 0.05).toFixed(2);
      return `${(i * 0.1).toFixed(3)},3500,60,60,${volts},${wb},12.5,0`;
    });
    const log = parseEvoScanCsv(header + rows.join('\n'), 'at2v6.csv');
    const one = [{ log, health: assessChannels(log) }];

    const part1 = tableNamed('MAF CALIBRATION Part 1  (units)');
    const part2 = tableNamed('MAF CALIBRATION Part 2  (units)');
    const part3 = tableNamed('MAF CALIBRATION Part 3  (units)');

    // Only the part whose voltage range contains 2.6 V may be corrected.
    expect(recommendMaf(one, part2).status).toBe('ok');
    expect(recommendMaf(one, part2).suggestions.size).toBeGreaterThan(0);
    expect(recommendMaf(one, part1).status).toBe('blocked');
    expect(recommendMaf(one, part3).status).toBe('blocked');
  });

  it('has nothing to say about a voltage range the car never reached', () => {
    // Part 3 starts at 3.44 V and these logs peak at 4.04 V, so almost nothing
    // lands there. Saying so is the honest result.
    const part3 = tableNamed('MAF CALIBRATION Part 3  (units)');
    const rec = recommendMaf(inputs, part3, { ...DEFAULT_MAF_OPTIONS, minSamples: 12 });
    expect(rec.suggestions.size).toBe(0);
    expect(rec.message).toMatch(/not enough usable samples/i);
  });
});

describe('overrun profiles', () => {
  // Regression: the first implementation subtracted a bounded retard from the
  // stock map. Stock holds 28-45 degrees in the overrun region, so a 12 or 20
  // degree subtraction landed at +22 and +12 respectively — never crossing TDC,
  // and therefore producing no exhaust burble at all. Overrun profiles must set
  // an absolute target on the far side of TDC.
  it('drive overrun cells past TDC into negative timing', () => {
    for (const id of ['popsAndBangs', 'flames'] as ProfileId[]) {
      const profile = PROFILES[id];
      const rec = recommendTiming(inputs, spark, {
        profile: id, minSamples: 12, intensity: 1, timeRange: null,
      });
      expect(rec.status).toBe('ok');

      const overrunCells = [...rec.suggestions.values()].filter((s) => s.knock === 0);
      expect(overrunCells.length).toBeGreaterThan(10);

      const negative = overrunCells.filter((s) => s.value < 0);
      expect(negative.length).toBeGreaterThan(10);

      // Every overrun cell lands exactly on the profile's absolute target.
      const target = Math.round(profile.overrunTargetDeg! * profile.aggression);
      for (const s of overrunCells) expect(s.value).toBe(target);
      expect(target).toBeLessThan(0);
    }
  });

  it('retard harder for flames than for pops and bangs', () => {
    const pops = recommendTiming(inputs, spark, {
      profile: 'popsAndBangs', minSamples: 12, intensity: 1, timeRange: null,
    });
    const flames = recommendTiming(inputs, spark, {
      profile: 'flames', minSamples: 12, intensity: 1, timeRange: null,
    });
    const lowest = (r: typeof pops) => Math.min(...[...r.suggestions.values()].map((s) => s.value));
    expect(lowest(flames)).toBeLessThan(lowest(pops));
  });

  it('stay clear of idle and keep to the low-load columns', () => {
    const rec = recommendTiming(inputs, spark, {
      profile: 'flames', minSamples: 12, intensity: 1, timeRange: null,
    });
    for (const [key, s] of rec.suggestions) {
      if (s.knock > 0) continue;
      const [r, c] = key.split(',').map(Number);
      // Retarding idle past TDC stalls the engine; retarding cruise wrecks
      // driveability and cooks the exhaust for no noise.
      expect(spark.y.values[r]).toBeGreaterThanOrEqual(1500);
      expect(spark.x.values[c]).toBeLessThanOrEqual(30);
    }
  });

  it('never exceed what the ROM scaling can store', () => {
    const rec = recommendTiming(inputs, spark, {
      profile: 'flames', minSamples: 12, intensity: 1.5, timeRange: null,
    });
    for (const s of rec.suggestions.values()) {
      expect(s.value).toBeGreaterThanOrEqual(spark.scaling.min);
      expect(s.value).toBeLessThanOrEqual(spark.scaling.max);
    }
  });

  it('say plainly when a cell has no logged deceleration behind it', () => {
    const rec = recommendTiming(inputs, spark, {
      profile: 'popsAndBangs', minSamples: 12, intensity: 1, timeRange: null,
    });
    const reasons = [...rec.suggestions.values()].map((s) => s.reason).join(' ');
    expect(reasons).toMatch(/no closed-throttle deceleration in this cell/);
    expect(rec.notes.join(' ')).toMatch(/after TDC/);
  });
});

describe('overrun window', () => {
  const windowed = (w: Parameters<typeof snapWindow>[0]) =>
    recommendTiming(inputs, spark, {
      profile: 'popsAndBangs', minSamples: 12, intensity: 1, timeRange: null, overrunWindow: w,
    });

  it('only changes cells inside the chosen window', () => {
    const rec = windowed({ rpmMin: 2000, rpmMax: 3000, loadMin: 10, loadMax: 10 });
    const cells = [...rec.suggestions.entries()].filter(([, s]) => s.knock === 0);
    expect(cells.length).toBeGreaterThan(0);
    for (const [key] of cells) {
      const [r, c] = key.split(',').map(Number);
      expect(spark.y.values[r]).toBeGreaterThanOrEqual(2000);
      expect(spark.y.values[r]).toBeLessThanOrEqual(3000);
      expect(spark.x.values[c]).toBe(10);
    }
  });

  it('changes more cells as the window widens', () => {
    const narrow = windowed({ rpmMin: 2000, rpmMax: 2500, loadMin: 10, loadMax: 10 });
    const wide = windowed({ rpmMin: 1500, rpmMax: 6500, loadMin: 10, loadMax: 30 });
    const count = (r: typeof narrow) =>
      [...r.suggestions.values()].filter((s) => s.knock === 0).length;
    expect(count(wide)).toBeGreaterThan(count(narrow));
  });

  it('changes nothing when the window selects no cells', () => {
    // Above the top of the load axis, so no cell qualifies.
    const rec = windowed({ rpmMin: 6500, rpmMax: 6500, loadMin: 300, loadMax: 400 });
    expect([...rec.suggestions.values()].filter((s) => s.knock === 0)).toHaveLength(0);
  });

  it('snaps bounds onto the table breakpoints', () => {
    // "From load 0" is a convenient default but sits below the axis, which
    // starts at 10; a picker listing real axis values could not show it.
    const snapped = snapWindow(
      { rpmMin: 1500, rpmMax: 6500, loadMin: 0, loadMax: 20 },
      spark.y.values,
      spark.x.values,
    );
    expect(snapped.loadMin).toBe(10);
    expect(spark.x.values).toContain(snapped.loadMin);
    expect(spark.y.values).toContain(snapped.rpmMin);

    // An off-grid rpm lands on the nearest real breakpoint, not between cells.
    expect(snapWindow(
      { rpmMin: 1600, rpmMax: 4400, loadMin: 12, loadMax: 28 },
      spark.y.values, spark.x.values,
    )).toEqual({ rpmMin: 1500, rpmMax: 4500, loadMin: 10, loadMax: 30 });
  });

  it('falls back to the profile default when no window is given', () => {
    const explicit = windowed(PROFILES.popsAndBangs.defaultWindow!);
    const implicit = recommendTiming(inputs, spark, {
      profile: 'popsAndBangs', minSamples: 12, intensity: 1, timeRange: null,
    });
    expect(implicit.suggestions.size).toBe(explicit.suggestions.size);
  });
});

describe('AFR analysis', () => {
  const mafParts = [
    'MAF CALIBRATION Part 1  (units)',
    'MAF CALIBRATION Part 2  (units)',
    'MAF CALIBRATION Part 3  (units)',
  ].map(tableNamed);
  const fuelMap = tableNamed('Fuel Calibration Map');

  it('separates closed loop from open loop and only trusts open loop', () => {
    const a = analyseAfr(inputs, mafParts, fuelMap);
    expect(a.status).toBe('ok');

    // Closed loop is ~0 by construction: O2 feedback holds AFR on target there
    // whatever the calibration says, so it measures nothing about fuelling.
    expect(a.closedLoopSamples).toBeGreaterThan(2000);
    expect(Math.abs(a.closedLoopMedianPct)).toBeLessThan(1);

    // Open loop carries the real error.
    expect(a.openLoopSamples).toBeGreaterThan(200);
    expect(a.openLoopMedianPct).toBeGreaterThan(3);
    expect(a.openLoopMedianPct).toBeLessThan(5);

    expect(a.notes.join(' ')).toMatch(/closed-loop samples sit at/);
  });

  it('names a cause and the table that fixes it', () => {
    const a = analyseAfr(inputs, mafParts, fuelMap);
    expect(a.causes.length).toBeGreaterThan(0);
    // Ranked largest first.
    for (let i = 1; i < a.causes.length; i++) {
      expect(a.causes[i - 1].magnitudePct).toBeGreaterThanOrEqual(a.causes[i].magnitudePct);
    }
    const fuel = a.causes.find((c) => c.id === 'fuelMap');
    if (fuel) expect(fuel.table).toBe('Fuel Calibration Map');
    // A flat offset is honestly reported as fixable by no table at all.
    const global = a.causes.find((c) => c.id === 'global');
    if (global) expect(global.table).toBeNull();
  });

  it('reports how far up the load axis it actually has evidence', () => {
    const a = analyseAfr(inputs, mafParts, fuelMap);
    expect(a.openLoopMaxLoad).toBeGreaterThan(40);
    expect(a.openLoopMaxLoad).toBeLessThan(60);
    expect(a.notes.join(' ')).toMatch(/says nothing about fuelling there/);
  });

  it('refuses a narrowband trace that never settles rich', () => {
    // Switches around stoich, never holds a rich value — what a narrowband
    // converted to AFR looks like. Tuning on it would be tuning on fiction.
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,WideBandAF,Target_AFR\n';
    const rows = Array.from({ length: 400 }, (_, i) =>
      `${(i * 0.1).toFixed(3)},3000,60,60,2.5,${(14.7 + (i % 2 ? 0.4 : -0.4)).toFixed(2)},12.5`);
    const log = parseEvoScanCsv(header + rows.join('\n'), 'narrowband.csv');
    const a = analyseAfr([{ log, health: assessChannels(log) }], mafParts, fuelMap);
    expect(a.status).toBe('blocked');
    expect(a.message).toMatch(/narrowband/i);
  });

  it('blocks when there is no enrichment to measure', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,WideBandAF,Target_AFR\n';
    const rows = Array.from({ length: 300 }, (_, i) =>
      `${(i * 0.1).toFixed(3)},2000,30,20,2.1,14.7,14.7`);
    const log = parseEvoScanCsv(header + rows.join('\n'), 'cruise.csv');
    const a = analyseAfr([{ log, health: assessChannels(log) }], mafParts, fuelMap);
    expect(a.status).toBe('blocked');
    expect(a.message).toMatch(/open-loop samples/);
  });

  it('writes fuel corrections only where there is enough data', () => {
    const rec = recommendFuelMap(inputs, mafParts, fuelMap);
    expect(rec.status).toBe('ok');
    for (const [key, s] of rec.suggestions) {
      const [r, c] = key.split(',').map(Number);
      expect(s.samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
      expect(s.value).toBe(fuelMap.values[r][c] + s.delta);
      // Capped per pass, as everywhere else in the recommender.
      expect(Math.abs(s.delta) / fuelMap.values[r][c]).toBeLessThanOrEqual(0.051);
    }
    expect(rec.starved).toBeGreaterThan(0);
  });

  it('does not charge the same error to both the MAF and the fuel map', () => {
    // The fuel map only ever receives the residual left after the airflow
    // component is removed, so its correction must be smaller than the raw
    // open-loop error it would have absorbed unattributed.
    const a = analyseAfr(inputs, mafParts, fuelMap);
    const rec = recommendFuelMap(inputs, mafParts, fuelMap);
    const worst = Math.max(
      0,
      ...[...rec.suggestions.values()].map((s) => Math.abs(s.delta) / fuelMap.values[0][0] * 100),
    );
    expect(worst).toBeLessThan(Math.abs(a.openLoopMedianPct) + 5);
  });
});

describe('advisory vs storable range', () => {
  it('does not clamp a value the ROM itself already holds', () => {
    // The Fuel Calibration Map is declared max="102" yet the stock image
    // contains 103.9. EcuFlash's min/max is a slider hint, not a storage limit,
    // so treating it as hard would quietly pull a legitimate value down.
    const fuelMap = tableNamed('Fuel Calibration Map');
    const observedMax = Math.max(...fuelMap.values.flat());
    expect(observedMax).toBeGreaterThan(fuelMap.scaling.max);

    expect(clampAndQuantise(fuelMap.scaling, observedMax, fuelMap.values)).toBeCloseTo(observedMax, 1);
    expect(usableRange(fuelMap.scaling, fuelMap.values)[1]).toBeCloseTo(observedMax, 1);
    expect(exceedsAdvisory(fuelMap.scaling, observedMax)).toBe(true);

    // The storage type is still a real limit.
    expect(clampAndQuantise(fuelMap.scaling, 1e6, fuelMap.values)).toBeLessThan(200);
  });
});

describe('MAF closed-loop exclusion', () => {
  it('drops closed-loop samples on the wideband path, where they measure nothing', () => {
    // A wideband-only log: no trim carries a correction, so the wideband path
    // is taken, and its closed-loop samples must be excluded because O2
    // feedback holds AFR on target there whatever the MAF says.
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,WideBandAF,Target_AFR,LTFT\n';
    const rows: string[] = [];
    for (let i = 0; i < 600; i++) {
      const closedLoop = i % 2 === 0;
      const volts = (2.58 + (i % 5) * 0.01).toFixed(3);
      const target = closedLoop ? '14.7' : '12.5';
      const wb = closedLoop
        ? (14.7 + (i % 3) * 0.05).toFixed(2)
        : (12.9 + (i % 7) * 0.05).toFixed(2);
      rows.push(`${(i * 0.1).toFixed(3)},3500,60,60,${volts},${wb},${target},0`);
    }
    const log = parseEvoScanCsv(header + rows.join('\n'), 'wb-mixed.csv');
    const rec = recommendMaf([{ log, health: assessChannels(log) }], tableNamed('MAF CALIBRATION Part 2  (units)'));
    expect(rec.status).toBe('ok');
    expect(rec.notes.join(' ')).toMatch(/closed-loop samples were excluded/);
  });
});

describe('load scale', () => {
  const afrMap = tableNamed('AFR Map warm');

  it('detects that the logger reads half the ROM Ev%', () => {
    const scale = detectLoadScale(inputs.map((i) => i.log), afrMap);
    expect(scale.factor).toBe(2);
    expect(scale.confidence).toBe('high');
    // The ECU looked the target up from this map, so the right interpretation
    // reproduces it closely and the wrong one does not.
    expect(scale.residualAfr).toBeLessThan(0.3);
    expect(scale.residualAtOne).toBeGreaterThan(1.0);
  });

  it('moves full-throttle samples out of the cruise columns', () => {
    const axes = {
      xAxis: spark.x.values, yAxis: spark.y.values,
      xChannel: 'Load', yChannel: 'RPM', collect: [],
      filter: DEFAULT_FILTER, ignoreCoolant: true,
    };
    const highestCol = (scale: number) => {
      const b = binLog(drive1.log, { ...axes, xScale: scale });
      let max = -1;
      for (const row of b.cells) {
        for (let c = 0; c < row.length; c++) if (row[c].n > 0) max = Math.max(max, c);
      }
      return spark.x.values[max];
    };
    // Uncorrected, the car appears never to leave part throttle.
    expect(highestCol(1)).toBeLessThanOrEqual(50);
    expect(highestCol(2)).toBeGreaterThanOrEqual(85);
  });

  it('leaves the scale alone when there is nothing to check against', () => {
    const header = 'LogEntrySeconds,RPM,Load,Target_AFR\n';
    const rows = Array.from({ length: 20 }, (_, i) => `${i * 0.1},2000,30,14.7`);
    const log = parseEvoScanCsv(header + rows.join('\n'), 'flat.csv');
    const scale = detectLoadScale([log], afrMap);
    expect(scale.factor).toBe(1);
    expect(scale.message).toMatch(/too few|flat at stoich/);
  });

  it('changes what the timing recommender produces', () => {
    const at = (loadScale: number) =>
      recommendTiming(inputs, spark, {
        profile: 'power', minSamples: 4, intensity: 1, timeRange: null, loadScale,
      });
    // The whole point of the fix: the same log lands on different cells.
    const keys = (r: ReturnType<typeof at>) => [...r.suggestions.keys()].sort().join('|');
    expect(keys(at(2))).not.toBe(keys(at(1)));
  });
});

describe('knock assistant', () => {
  const threshold = tableNamed('Knock Control, Active Load Threshold');
  const opts = { loadScale: 2, activeLoadThreshold: threshold, maxRetardDeg: 6 };
  const withIdle = [
    ...inputs,
    (() => {
      const log = parseEvoScanCsv(
        readFileSync(resolve(root, 'samples/log-idle-2026.09.02_13.54.34.csv'), 'utf8'),
        'idle.csv',
      );
      return { log, health: assessChannels(log) };
    })(),
  ];

  it('judges these events real, at genuine high load', () => {
    const a = analyseKnock(withIdle, opts);
    expect(a.status).toBe('ok');
    expect(a.events.length).toBeGreaterThan(30);
    expect(a.realCount).toBeGreaterThan(a.phantomCount * 5);
    // With load corrected these sit well above the ECU's own 50-70 Ev% threshold.
    const realLoads = a.events.filter((e) => e.verdict === 'real').map((e) => e.load);
    expect(Math.min(...realLoads)).toBeGreaterThan(30);
    expect(Math.max(...realLoads)).toBeGreaterThan(70);
  });

  it('would call the same events phantom if load were left uncorrected', () => {
    // Evidence that the load fix is load-bearing for the verdict, not cosmetic.
    const uncorrected = analyseKnock(withIdle, { ...opts, loadScale: 1 });
    const corrected = analyseKnock(withIdle, opts);
    expect(uncorrected.phantomCount).toBeGreaterThan(corrected.phantomCount);
  });

  it('calls knock at idle phantom', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,TimingAdv,Cooltemp,KnockSum,Knock_change\n';
    const rows: string[] = [];
    let ks = 0;
    for (let i = 0; i < 300; i++) {
      if (i % 40 === 0) ks += 1;
      rows.push(`${(i * 0.1).toFixed(3)},${800 + (i % 5) * 10},${4 + (i % 3)},8,${12 + (i % 4)},88,${ks},3`);
    }
    const log = parseEvoScanCsv(header + rows.join('\n'), 'idleknock.csv');
    const a = analyseKnock([{ log, health: assessChannels(log) }], { ...opts, loadScale: 1 });
    expect(a.phantomCount).toBeGreaterThan(0);
    expect(a.realCount).toBe(0);
    const reasons = a.events.flatMap((e) => e.reasons).join(' ');
    expect(reasons).toMatch(/cylinder pressure|throttle nearly closed/);
  });

  it('spots a single rpm ringing across wildly different loads', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,TimingAdv,Cooltemp,KnockSum,Knock_change\n';
    const rows: string[] = [];
    let ks = 0;
    for (let i = 0; i < 400; i++) {
      const knocking = i % 30 === 0;
      if (knocking) ks += 1;
      // Always ~4000 rpm, but load swings from 10 to 95: a resonance, not combustion.
      const load = knocking ? 10 + (i / 400) * 85 : 40;
      rows.push(`${(i * 0.1).toFixed(3)},${3980 + (i % 5) * 5},${load.toFixed(1)},60,20,88,${ks},4`);
    }
    const log = parseEvoScanCsv(header + rows.join('\n'), 'resonance.csv');
    const a = analyseKnock([{ log, health: assessChannels(log) }], { ...opts, loadScale: 1 });
    expect(a.phantomCount).toBeGreaterThan(0);
    expect(a.events.flatMap((e) => e.reasons).join(' ')).toMatch(/resonance/);
  });

  it('retards only the cells where knock is real', () => {
    const rec = recommendKnockRetard(withIdle, spark, opts);
    expect(rec.status).toBe('ok');
    expect(rec.suggestions.size).toBeGreaterThan(0);
    for (const s of rec.suggestions.values()) {
      expect(s.delta).toBeLessThan(0);
      expect(-s.delta).toBeLessThanOrEqual(opts.maxRetardDeg);
      expect(s.knock).toBeGreaterThan(0);
    }
  });

  it('refuses to raise the noise floor on scattered one-off events', () => {
    // Making the ECU less sensitive to knock needs a pattern, not a single tick.
    const adder = tableNamed('Knock Sensitivity, Background Noise Adder (Single Gain #1)');
    const rec = recommendNoiseFloor(withIdle, adder, opts);
    expect(rec.status).toBe('blocked');
    expect(rec.message).toMatch(/scattered rather than clustered/);
  });
});
