import { DEFAULT_VEHICLE } from './dyno';
import type { VehicleSpec } from './dyno';

/**
 * The car's specs and the dyno's units, kept in this browser.
 *
 * Kept apart from the project data for the same reason as the temperature
 * unit: the car does not change when you load a different log.
 */
const VEHICLE_KEY = '4b11-tuner.dyno-vehicle';
const UNITS_KEY = '4b11-tuner.dyno-units';

export type PowerUnits = 'imperial' | 'metric';

export function getVehicle(): VehicleSpec {
  try {
    const raw = localStorage.getItem(VEHICLE_KEY);
    if (!raw) return DEFAULT_VEHICLE;
    const saved = JSON.parse(raw) as Partial<VehicleSpec>;
    const merged = { ...DEFAULT_VEHICLE };
    for (const k of Object.keys(DEFAULT_VEHICLE) as (keyof VehicleSpec)[]) {
      const v = saved[k];
      if (typeof v === 'number' && Number.isFinite(v)) merged[k] = v;
    }
    return merged;
  } catch {
    return DEFAULT_VEHICLE;
  }
}

export function setVehicle(spec: VehicleSpec): void {
  try {
    localStorage.setItem(VEHICLE_KEY, JSON.stringify(spec));
  } catch {
    /* private browsing; the specs just will not persist */
  }
}

export function getPowerUnits(): PowerUnits {
  try {
    return localStorage.getItem(UNITS_KEY) === 'metric' ? 'metric' : 'imperial';
  } catch {
    return 'imperial';
  }
}

export function setPowerUnits(units: PowerUnits): void {
  try {
    localStorage.setItem(UNITS_KEY, units);
  } catch {
    /* ignore */
  }
}
