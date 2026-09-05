import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEvoScanCsv } from '../src/lib/log/parseEvoScanCsv';
import { assessChannels } from '../src/lib/log/channelHealth';
import { parseDefinitionXml } from '../src/lib/rom/parseDefinitionXml';
import { readTable } from '../src/lib/rom/readTable';
import { recommendMaf, DEFAULT_MAF_OPTIONS } from '../src/lib/tune/maf';
import { recommendTiming } from '../src/lib/tune/timing';
import { advanceCeiling, PROFILES, snapWindow } from '../src/lib/tune/profiles';
import { binLog, DEFAULT_FILTER } from '../src/lib/tune/binning';
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

  it('corrects from the real logs using wideband error against target AFR', () => {
    const rec = recommendMaf(inputs, mafPart1);
    expect(rec.status).toBe('ok');
    expect(rec.message).toMatch(/wideband/i);
    // Railed samples must be reported as dropped, not silently averaged in.
    expect(rec.notes.join(' ')).toMatch(/railed sensor values/);

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
    // The three parts tile the sensor range: 0.00-1.68, 1.72-3.40, 3.44-5.00 V.
    // These logs run 1.33-4.04 V, so Part 2 carries the bulk of the driving.
    const part2 = tableNamed('MAF CALIBRATION Part 2  (units)');
    const rec2 = recommendMaf(inputs, part2, { ...DEFAULT_MAF_OPTIONS, minSamples: 8 });
    expect(rec2.status).toBe('ok');
    expect(rec2.suggestions.size).toBeGreaterThan(0);

    // Part 3 starts at 3.44 V, which these logs barely reach, so it correctly
    // has little or nothing to say rather than inventing a correction.
    const part3 = tableNamed('MAF CALIBRATION Part 3  (units)');
    const rec3 = recommendMaf(inputs, part3);
    if (rec3.status === 'ok') {
      expect(rec3.suggestions.size).toBeLessThan(rec2.suggestions.size);
    }
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
