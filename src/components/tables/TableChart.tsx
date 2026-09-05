import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TableData } from '../../lib/rom/readTable';
import { heatColor } from '../../lib/log/palette';

export interface TableChartProps {
  table: TableData;
  /** Current values, [row][col]. */
  values: number[][];
  /** Optional overlay drawn dashed, e.g. the AI suggestion. */
  overlay?: number[][] | null;
  height?: number;
}

const PAD = { left: 54, right: 14, top: 12, bottom: 32 };

/**
 * The table as a curve rather than a grid.
 *
 * A 2D table (MAF transfer, for instance) draws as one line against its axis —
 * which is where a non-monotonic kink or a step becomes obvious in a way it
 * never is in a column of numbers. A 3D table draws one line per RPM row.
 */
export function TableChart({ table, values, overlay, height = 260 }: TableChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(300, host.clientWidth)));
    ro.observe(host);
    setWidth(Math.max(300, host.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // A single-column table plots against its Y axis; anything wider plots each
    // row against the X axis.
    const singleColumn = table.nx === 1;
    const axisValues = singleColumn ? table.y.values : table.x.values;
    const series: { points: number[]; color: string; label: string }[] = singleColumn
      ? [{ points: values.map((r) => r[0]), color: '#4ea1ff', label: table.def.name }]
      : values.map((row, r) => ({
          points: row,
          color: heatColor(values.length > 1 ? r / (values.length - 1) : 0.5),
          label: table.y.labels[r] ?? String(r),
        }));

    const overlaySeries: { points: number[] }[] | null = overlay
      ? singleColumn
        ? [{ points: overlay.map((r) => r[0]) }]
        : overlay.map((row) => ({ points: row }))
      : null;

    let lo = Infinity;
    let hi = -Infinity;
    for (const s of [...series, ...(overlaySeries ?? [])]) {
      for (const v of s.points) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;

    const axisLo = axisValues.length ? axisValues[0] : 0;
    const axisHi = axisValues.length ? axisValues[axisValues.length - 1] : 1;
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const sx = (i: number) =>
      PAD.left + (axisHi === axisLo
        ? (i / Math.max(1, axisValues.length - 1)) * plotW
        : ((axisValues[i] - axisLo) / (axisHi - axisLo)) * plotW);
    const sy = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

    ctx.strokeStyle = 'rgba(139,149,166,0.28)';
    ctx.strokeRect(PAD.left + 0.5, PAD.top + 0.5, plotW, plotH);

    // Y gridlines and labels.
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#8b95a6';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const v = lo + ((hi - lo) * i) / 5;
      const py = Math.round(sy(v)) + 0.5;
      ctx.strokeStyle = 'rgba(139,149,166,0.11)';
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + plotW, py);
      ctx.stroke();
      ctx.fillText(v.toFixed(table.decimals), PAD.left - 6, py + 3);
    }

    // X labels, thinned so they do not collide.
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(axisValues.length / 12));
    const axisLabels = singleColumn ? table.y.labels : table.x.labels;
    for (let i = 0; i < axisValues.length; i += step) {
      ctx.fillText(axisLabels[i] ?? '', sx(i), height - PAD.bottom + 14);
    }

    const drawSeries = (points: number[], color: string, dashed: boolean) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.5 : 1.75;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < points.length && i < axisValues.length; i++) {
        const v = points[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        if (started) ctx.lineTo(sx(i), sy(v));
        else { ctx.moveTo(sx(i), sy(v)); started = true; }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    for (const s of series) drawSeries(s.points, s.color, false);
    if (overlaySeries) {
      for (const s of overlaySeries) drawSeries(s.points, '#e8b04b', true);
    }

    // Axis titles.
    ctx.fillStyle = '#8b95a6';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    const xTitle = singleColumn
      ? `${table.y.name} (${table.y.units})`
      : `${table.x.name} (${table.x.units})`;
    ctx.fillText(xTitle, PAD.left + plotW / 2, height - 3);
  }, [table, values, overlay, width, height]);

  return (
    <div ref={hostRef}>
      <canvas ref={canvasRef} />
      {overlay && (
        <div className="muted small">Dashed line is the suggested curve.</div>
      )}
    </div>
  );
}
