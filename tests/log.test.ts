import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEvoScanCsv } from '../src/lib/log/parseEvoScanCsv';
import { assessChannels, fuelFeedback } from '../src/lib/log/channelHealth';
import { isPlausible, formatTemp, isTemperature, toDisplayTemp } from '../src/lib/log/channelMeta';
import { loggingAdvice } from '../src/lib/log/loggingAdvice';

const root = resolve(__dirname, '..');
const load = (file: string) =>
  parseEvoScanCsv(readFileSync(resolve(root, 'samples', file), 'utf8'), file);

const idle = load('log-idle-2026.09.02_13.54.34.csv');
const drive1 = load('log-drive-2026.09.02_14.21.59.csv');
const drive2 = load('log-drive-2026.09.02_14.28.42.csv');
const all = [idle, drive1, drive2];

describe('EvoScan CSV parsing', () => {
  it('reads every row and builds a zero-based time base', () => {
    expect(idle.rowCount).toBe(1533);
    expect(drive1.rowCount).toBe(1639);
    expect(drive2.rowCount).toBe(1864);
    expect(idle.time[0]).toBe(0);
    expect(idle.duration).toBeCloseTo(179.43, 1);
    expect(idle.sampleInterval).toBeGreaterThan(0.05);
    expect(idle.sampleInterval).toBeLessThan(0.5);
  });

  it('keeps empty cells as NaN rather than collapsing them to zero', () => {
    const stft = drive1.byName.get('STFT')!;
    expect(stft.n).toBe(0);
    expect(Number.isNaN(stft.values[0])).toBe(true);

    const knock = drive1.byName.get('KnockSum')!;
    expect(knock.n).toBe(drive1.rowCount);
    expect(knock.min).toBe(0);
  });

  it('classifies channels into groups and units', () => {
    expect(drive1.byName.get('RPM')!.unit).toBe('rpm');
    expect(drive1.byName.get('Load')!.unit).toBe('Ev%');
    expect(drive1.byName.get('MAF_Voltage')!.group).toBe('Airflow');
    expect(drive1.byName.get('TimingAdv')!.group).toBe('Spark');
    expect(drive1.textColumns).toContain('LogNotes');
  });

  it('agrees with the ranges observed in the raw files', () => {
    const rpm = drive1.byName.get('RPM')!;
    expect(rpm.max).toBeCloseTo(5625, 0);
    const maf = drive1.byName.get('MAF_Voltage')!;
    expect(maf.min).toBeGreaterThan(1.3);
    expect(maf.max).toBeLessThan(4.1);
  });
});

describe('channel health gate', () => {
  it('flags the broken channels in these logs', () => {
    for (const log of all) {
      const h = assessChannels(log);
      expect(h.get('IAT')!.status).toBe('dead');
      expect(h.get('IAT')!.reasons.join(' ')).toMatch(/plausible|stuck/);
      expect(h.get('MAT')!.status).toBe('dead');
      expect(h.get('STFT')!.status).toBe('dead');
      expect(h.get('STFT')!.reasons[0]).toMatch(/not logged/);
    }
  });

  it('keeps the wideband usable despite its railed samples', () => {
    // Roughly 10% of samples rail at 0 / 96 / 99.9. Those are sentinels to be
    // dropped per sample, not grounds for condemning the whole channel: the
    // rest reads 9.4-22 AFR and tracks commanded enrichment under load.
    for (const log of all) {
      const h = assessChannels(log).get('WideBandAF')!;
      expect(h.status).toBe('ok');
      expect(h.outOfRangeFraction).toBeGreaterThan(0);
      expect(h.outOfRangeFraction).toBeLessThan(0.2);
    }
    expect(isPlausible('WideBandAF', 99.9)).toBe(false);
    expect(isPlausible('WideBandAF', 0)).toBe(false);
    expect(isPlausible('WideBandAF', 12.6)).toBe(true);
  });

  it('flags long-term trims that never move', () => {
    for (const log of all) {
      const h = assessChannels(log).get('LTFT')!;
      expect(h.status).not.toBe('ok');
      expect(h.reasons.join(' ')).toMatch(/sits at|stuck/);
    }
  });

  it('flags coolant only in the drive logs, where it never warms', () => {
    expect(assessChannels(drive1).get('Cooltemp')!.status).toBe('suspect');
    expect(assessChannels(drive2).get('Cooltemp')!.status).toBe('suspect');
    // The idle log recorded a genuine warm-up from 14 to 64 C.
    expect(assessChannels(idle).get('Cooltemp')!.status).toBe('ok');
  });

  it('passes the channels that are actually good', () => {
    const h = assessChannels(drive1);
    for (const name of ['RPM', 'Load', 'MAF_Voltage', 'Airflow', 'TimingAdv', 'TPS', 'KnockSum']) {
      expect(h.get(name)!.status, `${name}: ${h.get(name)!.reasons.join('; ')}`).toBe('ok');
    }
  });
});

describe('fuel feedback availability', () => {
  it('prefers the long-term trim the ECU has actually learned', () => {
    // Plain LTFT reads 0 in these logs while the region-specific LTFT_Cruise
    // holds +4.3 to +5.1%. A steady non-zero long-term trim is the classic
    // MAF-scaling input, so picking the informative channel matters more than
    // matching a conventional name.
    for (const log of all) {
      const fb = fuelFeedback(log, assessChannels(log));
      expect(fb.source).toBe('trims');
      expect(fb.channels).toContain('LTFT_Cruise');
      // One short-term channel at most: a four-cylinder has a single bank, so
      // STFT and STFT#2 are the same quantity and adding both double-counts.
      expect(fb.channels.filter((c) => c.startsWith('STFT'))).toHaveLength(1);
    }
  });

  it('ignores a long-term trim sitting at zero', () => {
    for (const log of all) {
      const fb = fuelFeedback(log, assessChannels(log));
      expect(fb.channels).not.toContain('LTFT');
      expect(fb.channels).not.toContain('LTFT_High');
    }
  });

  it('falls back to the wideband when no trim carries a correction', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,WideBandAF,Target_AFR,LTFT\n';
    const rows = Array.from({ length: 200 }, (_, i) =>
      `${(i * 0.1).toFixed(3)},3000,60,60,2.5,${(12.0 + (i % 5) * 0.1).toFixed(2)},12.5,0`);
    const log = parseEvoScanCsv(header + rows.join('\n'), 'wb-only.csv');
    const fb = fuelFeedback(log, assessChannels(log));
    expect(fb.source).toBe('wideband');
    expect(fb.channels).toEqual(['WideBandAF', 'Target_AFR']);
  });

  it('reports no feedback when neither trims nor a wideband are logged', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,KnockSum\n';
    const rows = Array.from({ length: 50 }, (_, i) => `${(i * 0.1).toFixed(3)},2000,30,20,2.1,0`);
    const bare = parseEvoScanCsv(header + rows.join('\n'), 'bare.csv');
    const fb = fuelFeedback(bare, assessChannels(bare));
    expect(fb.source).toBe('none');
    expect(fb.reason).toMatch(/MAF scaling needs/);
  });
});

describe('logging setup advice', () => {
  const withHealth = (log: typeof idle) => ({ log, health: assessChannels(log) });
  const advice = loggingAdvice([idle, drive1, drive2].map(withHealth));
  const byId = (id: string) => advice.find((a) => a.id === id);

  it('ranks blocking findings above merely important ones', () => {
    const order = { blocking: 0, important: 1, minor: 2 };
    for (let i = 1; i < advice.length; i++) {
      expect(order[advice[i - 1].severity]).toBeLessThanOrEqual(order[advice[i].severity]);
    }
  });

  it('flags the sample rate as too coarse for high-rpm work', () => {
    const a = byId('sample-rate');
    expect(a).toBeDefined();
    expect(a!.severity).toBe('important');
    // ~4.8 Hz on the slowest of these logs.
    expect(a!.title).toMatch(/[45]\.\d Hz/);
  });

  it('spots transmission channels that cannot answer on a manual car', () => {
    const a = byId('sst-channels');
    expect(a).toBeDefined();
    expect(a!.detail).toMatch(/TC-SST/);
    expect(a!.detail).toMatch(/5MT/);
  });

  it('spots boost channels on a naturally aspirated engine', () => {
    expect(byId('na-channels')).toBeDefined();
  });

  it('flags the coolant request that differs between profiles', () => {
    const a = byId('sensor-Cooltemp');
    expect(a).toBeDefined();
    expect(a!.severity).toBe('important');
    expect(a!.unlocks).toMatch(/warm-engine filter/);
  });

  it('reports the unmeasured top of the load axis', () => {
    const a = byId('coverage-load');
    expect(a).toBeDefined();
    expect(a!.title).toMatch(/49 Ev%/);
    expect(a!.detail).toMatch(/third-gear pulls/);
  });

  it('does not call fuelling blocked, since a long-term trim is present', () => {
    // LTFT_Cruise carries a real correction, so this is not a blocker.
    expect(byId('no-feedback')).toBeUndefined();
    expect(byId('stft')!.severity).toBe('minor');
  });

  it('calls fuelling blocked when nothing measures it', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,KnockSum\n';
    const rows = Array.from({ length: 100 }, (_, i) =>
      `${(i * 0.05).toFixed(3)},${2000 + (i % 9) * 30},${30 + (i % 5)},20,${(2.1 + (i % 4) * 0.02).toFixed(2)},0`);
    const bare = parseEvoScanCsv(header + rows.join('\n'), 'bare.csv');
    const a = loggingAdvice([withHealth(bare)]).find((x) => x.id === 'no-feedback');
    expect(a).toBeDefined();
    expect(a!.severity).toBe('blocking');
  });

  it('says nothing when the setup is sound', () => {
    const header = 'LogEntrySeconds,RPM,Load,TPS,MAF_Voltage,WideBandAF,Target_AFR,LTFT,Cooltemp,KnockSum\n';
    const rows = Array.from({ length: 2000 }, (_, i) =>
      `${(i * 0.05).toFixed(3)},${2000 + (i % 40) * 100},${20 + (i % 70)},${20 + (i % 60)},` +
      `${(1.5 + (i % 30) * 0.08).toFixed(2)},${(12.5 + (i % 9) * 0.2).toFixed(2)},12.5,` +
      // Coolant has to move: a real sensor cycles with the thermostat, and a
      // perfectly constant reading is correctly flagged as stuck.
      `${(4 + (i % 5) * 0.4).toFixed(2)},${(86 + (i % 7) * 0.5).toFixed(1)},0`);
    const good = parseEvoScanCsv(header + rows.join('\n'), 'good.csv');
    expect(loggingAdvice([withHealth(good)])).toHaveLength(0);
  });
});

describe('temperature units', () => {
  it('converts for display without touching the underlying value', () => {
    expect(formatTemp(0, 'C')).toBe('0°C');
    expect(formatTemp(0, 'F')).toBe('32°F');
    expect(formatTemp(100, 'F')).toBe('212°F');
    expect(formatTemp(88, 'F')).toBe('190°F');
    expect(formatTemp(NaN, 'F')).toBe('—');
    expect(toDisplayTemp(-40, 'F')).toBe(-40);
  });

  it('knows which channels are temperatures', () => {
    expect(isTemperature('Cooltemp')).toBe(true);
    expect(isTemperature('IAT')).toBe(true);
    expect(isTemperature('RPM')).toBe(false);
    expect(isTemperature('WideBandAF')).toBe(false);
  });
});
