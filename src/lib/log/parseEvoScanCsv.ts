import { metaFor, NON_CHANNEL_COLUMNS } from './channelMeta';
import type { LogChannel, LogFile } from './types';

/**
 * Split one CSV line. EvoScan writes plain comma-separated values but LogNotes
 * can be quoted, so handle quotes rather than a naive split.
 */
function splitLine(line: string): string[] {
  if (line.indexOf('"') === -1) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return NaN;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * Parse an EvoScan datalog CSV.
 *
 * Blank cells become NaN, never 0 — the distinction between "this channel was
 * not logged" and "this channel read zero" is what the health gate depends on.
 */
export function parseEvoScanCsv(text: string, name: string, id?: string): LogFile {
  const lines = text.split(/\r?\n/);
  let h = 0;
  while (h < lines.length && lines[h].trim() === '') h++;
  if (h >= lines.length) throw new Error(`${name}: file is empty`);

  const header = splitLine(lines[h]).map((s) => s.trim());
  const rows: string[][] = [];
  for (let i = h + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    rows.push(splitLine(line));
  }
  if (rows.length === 0) throw new Error(`${name}: no data rows`);

  const secondsIdx = header.indexOf('LogEntrySeconds');
  const dateIdx = header.indexOf('LogEntryDate');
  const timeIdx = header.indexOf('LogEntryTime');

  // Time base: prefer LogEntrySeconds, fall back to row index at a nominal 10 Hz.
  const time = new Float64Array(rows.length);
  if (secondsIdx >= 0) {
    let t0 = NaN;
    for (let r = 0; r < rows.length; r++) {
      const v = parseFloat(rows[r][secondsIdx]);
      if (!Number.isNaN(v) && Number.isNaN(t0)) t0 = v;
      time[r] = Number.isNaN(v) ? NaN : v - t0;
    }
    // Fill any gaps by carrying the previous timestamp forward.
    for (let r = 0; r < time.length; r++) {
      if (Number.isNaN(time[r])) time[r] = r > 0 ? time[r - 1] : 0;
    }
  } else {
    for (let r = 0; r < rows.length; r++) time[r] = r * 0.1;
  }

  const channels: LogChannel[] = [];
  const textColumns: string[] = [];

  for (let c = 0; c < header.length; c++) {
    const colName = header[c];
    if (colName === '') continue;
    if (NON_CHANNEL_COLUMNS.has(colName)) {
      if (colName !== 'LogEntrySeconds' && colName !== 'LogID') textColumns.push(colName);
      continue;
    }

    const values = new Float64Array(rows.length);
    let n = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let nonNumeric = 0;

    for (let r = 0; r < rows.length; r++) {
      const raw = rows[r][c];
      if (raw === undefined || raw === '') { values[r] = NaN; continue; }
      const v = Number(raw);
      if (Number.isNaN(v)) { values[r] = NaN; nonNumeric++; continue; }
      values[r] = v;
      n++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    // A column that never parsed as a number is text, not a measurement.
    if (n === 0 && nonNumeric > 0) { textColumns.push(colName); continue; }

    const meta = metaFor(colName);
    channels.push({
      name: colName,
      unit: meta.unit,
      group: meta.group,
      values,
      n,
      min: n ? min : NaN,
      max: n ? max : NaN,
      mean: n ? sum / n : NaN,
    });
  }

  const byName = new Map(channels.map((ch) => [ch.name, ch]));

  const deltas: number[] = [];
  for (let r = 1; r < time.length; r++) {
    const d = time[r] - time[r - 1];
    if (d > 0) deltas.push(d);
  }
  deltas.sort((a, b) => a - b);

  const startedAt =
    dateIdx >= 0 && timeIdx >= 0 && rows[0][dateIdx]
      ? `${rows[0][dateIdx]} ${rows[0][timeIdx] ?? ''}`.trim()
      : null;

  return {
    id: id ?? `${name}-${Date.now()}`,
    name,
    time,
    channels,
    byName,
    rowCount: rows.length,
    duration: time[time.length - 1] - time[0],
    sampleInterval: deltas.length ? median(deltas) : 0.1,
    startedAt,
    textColumns,
  };
}
