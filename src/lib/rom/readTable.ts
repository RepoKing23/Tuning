import { compileExpr, decimalsFor, formatValue } from './scaling';
import type { AxisDef, RomDefinition, Scaling, StorageType, TableDef } from './parseDefinitionXml';

export const STORAGE_SIZE: Record<StorageType, number> = {
  uint8: 1, int8: 1,
  uint16: 2, int16: 2,
  uint32: 4, int32: 4,
  float: 4, bloblist: 1,
};

function readRaw(view: DataView, offset: number, type: StorageType, big: boolean): number {
  const little = !big;
  switch (type) {
    case 'uint8': case 'bloblist': return view.getUint8(offset);
    case 'int8': return view.getInt8(offset);
    case 'uint16': return view.getUint16(offset, little);
    case 'int16': return view.getInt16(offset, little);
    case 'uint32': return view.getUint32(offset, little);
    case 'int32': return view.getInt32(offset, little);
    case 'float': return view.getFloat32(offset, little);
  }
}

export interface AxisData {
  name: string;
  units: string;
  /** Display-scale values. Empty for static axes. */
  values: number[];
  labels: string[];
}

export interface TableData {
  def: TableDef;
  scaling: Scaling;
  units: string;
  decimals: number;
  nx: number;
  ny: number;
  x: AxisData;
  y: AxisData;
  /** Display-scale values indexed [row = y][col = x], matching EcuFlash's layout. */
  values: number[][];
  /** Raw storage values, same indexing. */
  raw: number[][];
}

const IDENTITY_SCALING: Scaling = {
  name: '(raw)',
  units: '',
  toexpr: 'x',
  frexpr: 'x',
  format: '%.0f',
  min: -Infinity,
  max: Infinity,
  inc: 1,
  storagetype: 'uint8',
  endian: 'big',
};

function resolveScaling(def: RomDefinition, name: string | undefined): Scaling {
  if (!name) return IDENTITY_SCALING;
  return def.scalings.get(name) ?? IDENTITY_SCALING;
}

function readAxis(rom: Uint8Array, def: RomDefinition, axis: AxisDef | undefined): AxisData {
  if (!axis) return { name: '', units: '', values: [], labels: [''] };

  if (axis.staticLabels && axis.staticLabels.length) {
    return {
      name: axis.name,
      units: '',
      values: axis.staticLabels.map((_, i) => i),
      labels: axis.staticLabels,
    };
  }

  const scaling = resolveScaling(def, axis.scaling);
  const size = STORAGE_SIZE[scaling.storagetype];
  const to = compileExpr(scaling.toexpr);
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const values: number[] = [];
  const labels: string[] = [];

  for (let i = 0; i < axis.elements; i++) {
    const offset = (axis.address ?? 0) + i * size;
    if (offset + size > rom.byteLength) break;
    const v = to(readRaw(view, offset, scaling.storagetype, scaling.endian === 'big'));
    values.push(v);
    labels.push(formatValue(v, scaling.format));
  }

  return { name: axis.name, units: scaling.units, values, labels };
}

/**
 * Read one table out of a ROM image.
 *
 * Storage layout follows EcuFlash: values are row-major over Y by default, and
 * column-major (X-major) when the table declares `swapxy="true"`. Both are
 * returned in the same display orientation — rows are the Y axis (RPM), columns
 * are the X axis (Load) — so the grid matches what EcuFlash shows.
 */
export function readTable(rom: Uint8Array, def: RomDefinition, table: TableDef): TableData {
  const scaling = resolveScaling(def, table.scaling);
  const size = STORAGE_SIZE[scaling.storagetype];
  const to = compileExpr(scaling.toexpr);
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);

  const x = readAxis(rom, def, table.xAxis);
  const y = readAxis(rom, def, table.yAxis);

  let nx = table.xAxis ? x.values.length : 1;
  let ny = table.yAxis ? y.values.length : 1;
  if (table.dims === '1D') { nx = 1; ny = 1; }
  if (nx === 0) nx = 1;
  if (ny === 0) ny = 1;

  const values: number[][] = [];
  const raw: number[][] = [];

  for (let row = 0; row < ny; row++) {
    const vRow: number[] = [];
    const rRow: number[] = [];
    for (let col = 0; col < nx; col++) {
      const index = table.swapxy ? col * ny + row : row * nx + col;
      const offset = table.address + index * size;
      if (offset + size > rom.byteLength) { vRow.push(NaN); rRow.push(NaN); continue; }
      const r = readRaw(view, offset, scaling.storagetype, scaling.endian === 'big');
      rRow.push(r);
      vRow.push(to(r));
    }
    values.push(vRow);
    raw.push(rRow);
  }

  return {
    def: table,
    scaling,
    units: scaling.units,
    decimals: decimalsFor(scaling.format),
    nx,
    ny,
    x: table.xAxis ? x : { name: '', units: '', values: [0], labels: [''] },
    y: table.yAxis ? y : { name: '', units: '', values: [0], labels: [''] },
    values,
    raw,
  };
}

/**
 * Quantise a display value onto the grid the ECU can actually store, by running
 * it through the scaling's `frexpr`, rounding to the storage type, and back.
 * Keeps the editor honest: you see the value that would really be written.
 */
export function quantise(scaling: Scaling, display: number): number {
  const from = compileExpr(scaling.frexpr);
  const to = compileExpr(scaling.toexpr);
  let rawValue = from(display);
  if (!Number.isFinite(rawValue)) return display;

  if (scaling.storagetype !== 'float') {
    rawValue = Math.round(rawValue);
    const limits: Record<string, [number, number]> = {
      uint8: [0, 255], int8: [-128, 127],
      uint16: [0, 65535], int16: [-32768, 32767],
      uint32: [0, 4294967295], int32: [-2147483648, 2147483647],
      bloblist: [0, 255],
    };
    const lim = limits[scaling.storagetype];
    if (lim) rawValue = Math.min(lim[1], Math.max(lim[0], rawValue));
  }
  return to(rawValue);
}

/** Clamp a display value to the scaling's declared min/max, then quantise. */
export function clampAndQuantise(scaling: Scaling, display: number): number {
  const clamped = Math.min(scaling.max, Math.max(scaling.min, display));
  return quantise(scaling, clamped);
}
