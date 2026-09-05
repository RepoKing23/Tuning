import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDefinitionXml } from '../src/lib/rom/parseDefinitionXml';
import { readTable, clampAndQuantise } from '../src/lib/rom/readTable';
import { identifyRom } from '../src/lib/rom/romIdentify';
import { compileExpr } from '../src/lib/rom/scaling';

const root = resolve(__dirname, '..');
const rom = new Uint8Array(readFileSync(resolve(root, 'samples/stock_2.bin')));
const def = parseDefinitionXml(readFileSync(resolve(root, 'samples/54740002-LancerX-MUT-v2.xml'), 'utf8'));

const table = (name: string) => {
  const t = def.tables.find((d) => d.name === name);
  if (!t) throw new Error(`no table "${name}"`);
  return t;
};

describe('definition parsing', () => {
  it('reads the romid block', () => {
    expect(def.romid.xmlid).toBe('54740002');
    expect(def.romid.internalidhex).toBe('54740002');
    expect(def.romid.internalidaddress).toBe(0x5002a);
    expect(def.romid.submodel).toBe('4B11 2.0 litre NA');
  });

  it('finds every table and category', () => {
    expect(def.tables.length).toBeGreaterThan(100);
    expect(def.categories).toContain('SPARK');
    expect(def.categories).toContain('MAF');
    expect(def.scalings.get('Load')?.toexpr).toBe('x*10/32');
    expect(def.scalings.get('Timing')?.storagetype).toBe('int8');
  });
});

describe('rom identification', () => {
  it('matches the stock image against its definition', () => {
    const id = identifyRom(rom, def);
    expect(id.sizeBytes).toBe(1048576);
    expect(id.found).toBe('54740002');
    expect(id.matches).toBe(true);
  });

  it('rejects an image whose id byte differs', () => {
    const bad = rom.slice();
    bad[0x5002a] = 0x99;
    expect(identifyRom(bad, def).matches).toBe(false);
  });
});

describe('scaling expressions', () => {
  it('evaluates the arithmetic used by this definition', () => {
    expect(compileExpr('x*10/32')(32)).toBeCloseTo(10);
    expect(compileExpr('x*1000/256')(128)).toBeCloseTo(500);
    expect(compileExpr('14.7*128/x')(128)).toBeCloseTo(14.7);
    expect(compileExpr('x*5/1024')(1024)).toBeCloseTo(5);
    expect(compileExpr('-(x+2)*3')(1)).toBeCloseTo(-9);
    expect(compileExpr('abs(0-x)')(5)).toBeCloseTo(5);
  });

  it('refuses anything that is not arithmetic', () => {
    expect(() => compileExpr('fetch("http://x")')).toThrow();
    expect(() => compileExpr('x; alert(1)')).toThrow();
    expect(() => compileExpr('globalThis')).toThrow();
  });

  it('round-trips display values through frexpr and back', () => {
    const timing = def.scalings.get('Timing')!;
    expect(clampAndQuantise(timing, 28)).toBe(28);
    // Timing is int8 with declared limits of -61..61.
    expect(clampAndQuantise(timing, 200)).toBe(61);
    expect(clampAndQuantise(timing, -200)).toBe(-61);
  });
});

describe('table reading', () => {
  it('reads the High Octane Spark Map with the axes EcuFlash shows', () => {
    const t = readTable(rom, def, table('High Octane Spark Map'));
    expect(t.nx).toBe(13);
    expect(t.ny).toBe(20);
    expect(t.x.name).toBe('Load');
    expect(t.y.name).toBe('RPM');
    expect(t.y.values.map(Math.round)).toEqual([
      500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750,
      3000, 3250, 3500, 3750, 4000, 4500, 5000, 5500, 6000, 6500,
    ]);
    expect(t.x.values.map(Math.round)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 100, 260,
    ]);
    expect(t.units).toBe('degrees');
  });

  it('honours swapxy column-major storage', () => {
    const t = readTable(rom, def, table('High Octane Spark Map'));
    // With swapxy the first 20 stored bytes are the load=10 column down the RPM
    // axis, so column 0 must read 10,10,16,22,28,... not the first row.
    const col0 = t.values.map((row) => row[0]);
    expect(col0.slice(0, 6)).toEqual([10, 10, 16, 22, 28, 30]);
    // Row 0 is 500 rpm across the whole load axis. Read row-major instead of
    // column-major and this comes back as the first stored column, not this.
    expect(t.values[0]).toEqual([10, 10, 10, 10, 6, -1, -4, -4, -4, -4, -4, -5, -11]);
    expect(t.values[5]).toEqual([30, 30, 30, 30, 25, 19, 15, 14, 13, 12, 11, 9, 3]);
  });

  it('reads the MAF calibration parts and their voltage axes', () => {
    const p1 = readTable(rom, def, table('MAF CALIBRATION Part 1  (units)'));
    expect(p1.nx).toBe(1);
    expect(p1.ny).toBe(44);
    expect(p1.y.name).toBe('AIR FLOW SENSOR');
    expect(p1.y.units).toBe('Volts');
    const volts = p1.y.values.slice(0, 5).map((v) => Number(v.toFixed(2)));
    expect(volts).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
    expect(p1.y.values[43]).toBeCloseTo(43 * 5 / 1024 * 8, 1);

    const p3 = readTable(rom, def, table('MAF CALIBRATION Part 3  (units)'));
    expect(p3.ny).toBe(42);
  });

  it('reads a 3D fuel table without swapping the wrong way', () => {
    const t = readTable(rom, def, table('Fuel Calibration Map'));
    expect(t.nx).toBe(19);
    expect(t.ny).toBe(16);
    expect(t.values.length).toBe(16);
    expect(t.values[0].length).toBe(19);
  });
});
