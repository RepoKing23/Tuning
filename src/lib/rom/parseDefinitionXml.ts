/**
 * Parser for EcuFlash ROM definition XML (`<rom>` / `<scaling>` / `<table>`).
 *
 * Hand-rolled rather than DOMParser so the same code runs in the browser and in
 * node tests without a DOM shim. The definition dialect is simple: no CDATA, no
 * namespaces, no processing instructions beyond an optional prolog.
 */

export type StorageType =
  | 'uint8' | 'int8'
  | 'uint16' | 'int16'
  | 'uint32' | 'int32'
  | 'float' | 'bloblist';

export interface Scaling {
  name: string;
  units: string;
  toexpr: string;
  frexpr: string;
  format: string;
  min: number;
  max: number;
  inc: number;
  storagetype: StorageType;
  endian: 'big' | 'little';
  /** Present for `bloblist` scalings: raw hex value -> label. */
  blob?: { value: string; name: string }[];
}

export type AxisKind = 'X Axis' | 'Y Axis' | 'Static X Axis' | 'Static Y Axis';

export interface AxisDef {
  name: string;
  kind: AxisKind;
  elements: number;
  /** Absent for static axes, which carry literal labels instead. */
  address?: number;
  scaling?: string;
  staticLabels?: string[];
}

export interface TableDef {
  /** Stable identity: name + address, since names repeat across variants. */
  id: string;
  name: string;
  category: string;
  address: number;
  dims: '1D' | '2D' | '3D';
  swapxy: boolean;
  scaling: string;
  xAxis?: AxisDef;
  yAxis?: AxisDef;
}

export interface RomId {
  xmlid: string;
  internalidaddress: number;
  internalidhex: string;
  make: string;
  market: string;
  model: string;
  submodel: string;
  transmission: string;
  year: string;
  flashmethod: string;
  memmodel: string;
}

export interface RomDefinition {
  romid: RomId;
  scalings: Map<string, Scaling>;
  tables: TableDef[];
  categories: string[];
}

// --- minimal XML tree -------------------------------------------------------

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * Scan the document element by element.
 *
 * This is a character scanner rather than a regex because attribute values in
 * real EcuFlash definitions contain `>` — `units="AirFlow -> Load%"` and table
 * names like `DTC disable P1233 ... 0014-->ffff`. A regex that stops at the
 * first `>` truncates those tags and desynchronises the whole document.
 */
function parseXml(source: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;

  const addText = (text: string) => {
    if (text.trim()) stack[stack.length - 1].text += text;
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) { addText(source.slice(i)); break; }
    addText(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      addText(source.slice(lt + 9, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    // Find the closing '>' of this tag, ignoring any that sit inside quotes.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < source.length) {
      const c = source[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const inner = source.slice(lt + 1, j);
    i = j + 1;

    if (inner.startsWith('!')) continue; // doctype and friends

    if (inner.startsWith('/')) {
      const tag = inner.slice(1).trim();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) { stack.length = s; break; }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^[A-Za-z_:][-A-Za-z0-9_:.]*/.exec(body.trimStart());
    if (!nameMatch) continue;
    const tag = nameMatch[0];

    const node: XmlNode = {
      tag,
      attrs: parseAttrs(body.slice(body.indexOf(tag) + tag.length)),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

// --- definition mapping -----------------------------------------------------

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Definition addresses are bare hex, with no 0x prefix. */
function hexAddr(v: string | undefined): number {
  if (!v) return NaN;
  return parseInt(v.trim().replace(/^0x/i, ''), 16);
}

function findChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

function childText(node: XmlNode | undefined, tag: string): string {
  const c = node ? findChild(node, tag) : undefined;
  return c ? c.text.trim() : '';
}

function toScaling(node: XmlNode): Scaling {
  const a = node.attrs;
  const storagetype = (a.storagetype ?? 'uint8') as StorageType;
  const scaling: Scaling = {
    name: a.name ?? '',
    units: a.units ?? '',
    toexpr: a.toexpr ?? 'x',
    frexpr: a.frexpr ?? 'x',
    format: a.format ?? '%.0f',
    min: num(a.min, -Infinity),
    max: num(a.max, Infinity),
    inc: num(a.inc, 1),
    storagetype,
    endian: a.endian === 'little' ? 'little' : 'big',
  };
  if (storagetype === 'bloblist') {
    scaling.blob = node.children
      .filter((c) => c.tag === 'data')
      .map((c) => ({ value: c.attrs.value ?? '', name: c.attrs.name ?? c.attrs.value ?? '' }));
  }
  return scaling;
}

function toAxis(node: XmlNode): AxisDef {
  const a = node.attrs;
  const kind = a.type as AxisKind;
  const axis: AxisDef = {
    name: a.name ?? '',
    kind,
    elements: num(a.elements, 0),
    scaling: a.scaling,
  };
  if (a.address) axis.address = hexAddr(a.address);
  if (kind === 'Static X Axis' || kind === 'Static Y Axis') {
    axis.staticLabels = node.children
      .filter((c) => c.tag === 'data')
      .map((c) => c.text.trim());
  }
  return axis;
}

export function parseDefinitionXml(source: string): RomDefinition {
  const tree = parseXml(source);
  const rom = findChild(tree, 'rom');
  if (!rom) throw new Error('not an EcuFlash definition: no <rom> element');

  const romidNode = findChild(rom, 'romid');
  const romid: RomId = {
    xmlid: childText(romidNode, 'xmlid'),
    internalidaddress: hexAddr(childText(romidNode, 'internalidaddress')),
    internalidhex: childText(romidNode, 'internalidhex'),
    make: childText(romidNode, 'make'),
    market: childText(romidNode, 'market'),
    model: childText(romidNode, 'model'),
    submodel: childText(romidNode, 'submodel'),
    transmission: childText(romidNode, 'transmission'),
    year: childText(romidNode, 'year'),
    flashmethod: childText(romidNode, 'flashmethod'),
    memmodel: childText(romidNode, 'memmodel'),
  };

  const scalings = new Map<string, Scaling>();
  for (const node of rom.children) {
    if (node.tag !== 'scaling') continue;
    const s = toScaling(node);
    if (s.name) scalings.set(s.name, s);
  }

  const tables: TableDef[] = [];
  for (const node of rom.children) {
    if (node.tag !== 'table') continue;
    const a = node.attrs;
    const dims = (a.type ?? '') as TableDef['dims'];
    if (dims !== '1D' && dims !== '2D' && dims !== '3D') continue;

    const address = hexAddr(a.address);
    if (!Number.isFinite(address)) continue;

    const def: TableDef = {
      id: `${a.name ?? ''}@${a.address ?? ''}`,
      name: a.name ?? '(unnamed)',
      category: a.category ?? 'Uncategorised',
      address,
      dims,
      swapxy: a.swapxy === 'true',
      scaling: a.scaling ?? '',
    };

    for (const child of node.children) {
      if (child.tag !== 'table') continue;
      const kind = child.attrs.type;
      if (kind === 'X Axis' || kind === 'Static X Axis') def.xAxis = toAxis(child);
      else if (kind === 'Y Axis' || kind === 'Static Y Axis') def.yAxis = toAxis(child);
    }

    tables.push(def);
  }

  const categories = [...new Set(tables.map((t) => t.category))].sort();
  return { romid, scalings, tables, categories };
}
