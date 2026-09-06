import type { TempUnit } from './channelMeta';

/**
 * Display preferences, kept in this browser.
 *
 * Deliberately separate from the project data: a unit choice is about how you
 * read the numbers, not about the car, and should survive loading a different
 * ROM or log.
 */
const TEMP_UNIT_KEY = '4b11-tuner.temp-unit';

export function getTempUnit(): TempUnit {
  try {
    return localStorage.getItem(TEMP_UNIT_KEY) === 'F' ? 'F' : 'C';
  } catch {
    return 'C';
  }
}

export function setTempUnit(unit: TempUnit): void {
  try {
    localStorage.setItem(TEMP_UNIT_KEY, unit);
  } catch {
    /* private browsing; the choice just will not persist */
  }
}
