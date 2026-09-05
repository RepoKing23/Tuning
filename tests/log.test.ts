import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEvoScanCsv } from '../src/lib/log/parseEvoScanCsv';
import { assessChannels, fuelFeedback } from '../src/lib/log/channelHealth';

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

  it('flags the wideband as unusable', () => {
    for (const log of all) {
      expect(assessChannels(log).get('WideBandAF')!.status).not.toBe('ok');
    }
  });

  it('flags long-term trims that never move', () => {
    for (const log of all) {
      const h = assessChannels(log).get('LTFT')!;
      expect(h.status).not.toBe('ok');
      expect(h.reasons.join(' ')).toMatch(/varies by only|stuck/);
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
  it('reports no usable feedback for these logs', () => {
    for (const log of all) {
      const fb = fuelFeedback(log, assessChannels(log));
      expect(fb.source).toBe('none');
      expect(fb.reason).toMatch(/MAF scaling needs/);
    }
  });
});
