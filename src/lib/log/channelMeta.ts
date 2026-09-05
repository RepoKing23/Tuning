import type { ChannelGroup } from './types';

interface Meta {
  unit: string;
  group: ChannelGroup;
  /** Physically plausible range for a running 4B11. Used by the health gate. */
  plausible?: [number, number];
  /** True when the channel legitimately sits at one value for long stretches. */
  constantOk?: boolean;
}

/**
 * Known EvoScan / MUT channels for the 4B11. Anything not listed still loads and
 * plots — it just gets no unit and no plausibility check.
 */
export const CHANNEL_META: Record<string, Meta> = {
  RPM: { unit: 'rpm', group: 'Engine', plausible: [0, 9000] },
  Speed: { unit: 'km/h', group: 'Engine', plausible: [0, 300], constantOk: true },
  Load: { unit: 'Ev%', group: 'Engine', plausible: [0, 300] },
  TPS: { unit: '%', group: 'Engine', plausible: [0, 100] },
  Boost: { unit: 'psi', group: 'Engine', plausible: [-15, 40] },
  Octane: { unit: '', group: 'Engine', plausible: [0, 255], constantOk: true },

  MAF_Voltage: { unit: 'V', group: 'Airflow', plausible: [0, 5] },
  Airflow: { unit: 'g/s', group: 'Airflow', plausible: [0, 1200] },

  IPW: { unit: 'ms', group: 'Fuel', plausible: [0, 30] },
  WideBandAF: { unit: 'AFR', group: 'Fuel', plausible: [8, 22] },
  Target_AFR: { unit: 'AFR', group: 'Fuel', plausible: [8, 22], constantOk: true },
  STFT: { unit: '%', group: 'Fuel', plausible: [-30, 30] },
  LTFT: { unit: '%', group: 'Fuel', plausible: [-30, 30], constantOk: true },
  LTFT_Idle: { unit: '%', group: 'Fuel', plausible: [-30, 30], constantOk: true },
  LTFT_Cruise: { unit: '%', group: 'Fuel', plausible: [-30, 30], constantOk: true },
  LTFT_High: { unit: '%', group: 'Fuel', plausible: [-30, 30], constantOk: true },
  'STFT#2': { unit: '%', group: 'Fuel', plausible: [-30, 30] },
  'LTFT_High#2': { unit: '%', group: 'Fuel', plausible: [-30, 30], constantOk: true },
  'LTFT_Mid#2': { unit: '%', group: 'Fuel', plausible: [-30, 30], constantOk: true },

  TimingAdv: { unit: '°', group: 'Spark', plausible: [-25, 60] },
  KnockSum: { unit: 'count', group: 'Spark', plausible: [0, 255], constantOk: true },
  Knock_change: { unit: 'count', group: 'Spark', plausible: [0, 255], constantOk: true },

  Cooltemp: { unit: '°C', group: 'Temps', plausible: [-20, 130] },
  IAT: { unit: '°C', group: 'Temps', plausible: [-20, 100] },
  MAT: { unit: '°C', group: 'Temps', plausible: [-20, 120] },
  Trans_Temp: { unit: '°C', group: 'Temps', plausible: [-20, 160] },

  ActiveWGDC: { unit: '%', group: 'Engine', plausible: [0, 100], constantOk: true },

  OddClutchTemp: { unit: '°C', group: 'Trans' },
  EvenClutchTemp: { unit: '°C', group: 'Trans' },
  OddClutchPressure: { unit: 'kPa', group: 'Trans' },
  EvenClutchPressure: { unit: 'kPa', group: 'Trans' },
  OddClutchSlipSpeed: { unit: 'rpm', group: 'Trans' },
  EvenClutchSlipSpeed: { unit: 'rpm', group: 'Trans' },
  OddInputShaftSpeed: { unit: 'rpm', group: 'Trans' },
  EvenInputShaftSpeed: { unit: 'rpm', group: 'Trans' },
};

export function metaFor(name: string): Meta {
  return CHANNEL_META[name] ?? { unit: '', group: 'Other' };
}

/** Columns that carry the time base or free text rather than a measurement. */
export const NON_CHANNEL_COLUMNS = new Set([
  'LogID',
  'LogEntryDate',
  'LogEntryTime',
  'LogEntrySeconds',
  'LogNotes',
  'Custom',
]);
