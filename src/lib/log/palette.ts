/** Distinguishable series colours, stable per channel name. */
const PALETTE = [
  '#4ea1ff', '#e8b04b', '#4ec97f', '#ef5f5f', '#b98cff',
  '#3fd0c9', '#ff8f4e', '#8fd14f', '#ff6ec7', '#7f9dd6',
  '#d4c86a', '#5fd0a0', '#ff9f9f', '#c39cff', '#63c2e0',
];

const assigned = new Map<string, string>();

export function colorFor(name: string): string {
  const hit = assigned.get(name);
  if (hit) return hit;
  // Hash the name so a channel keeps its colour across logs and reloads.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const color = PALETTE[h % PALETTE.length];
  assigned.set(name, color);
  return color;
}

/** Blue -> red ramp used for heatmaps and scatter colouring. */
export function heatColor(t: number): string {
  const stops: [number, number, number][] = [
    [47, 111, 208], [73, 182, 196], [87, 192, 106],
    [220, 212, 90], [224, 140, 63], [216, 74, 74],
  ];
  if (!Number.isFinite(t)) return '#555c68';
  const clamped = Math.min(1, Math.max(0, t));
  const pos = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const [r1, g1, b1] = stops[i];
  const [r2, g2, b2] = stops[i + 1];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}
