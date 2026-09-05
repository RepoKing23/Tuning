import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LogFile } from '../../lib/log/types';
import { heatColor } from '../../lib/log/palette';
import { isPlausible } from '../../lib/log/channelMeta';

export interface ScatterViewProps {
  logs: LogFile[];
  xChannel: string;
  yChannel: string;
  /** Channel that colours each point. Empty string draws them all one colour. */
  colorChannel: string;
  timeRange?: [number, number] | null;
  height?: number;
  /** Draw these axis values as gridlines, so the plot lines up with a table. */
  xGrid?: number[];
  yGrid?: number[];
}

const PAD = { left: 58, right: 16, top: 12, bottom: 34 };

/**
 * RPM against Load, coloured by a third channel.
 *
 * This is the view that connects a log to a map: every point is a moment the
 * engine spent somewhere on the same grid the spark and fuel tables use.
 */
export function ScatterView({
  logs, xChannel, yChannel, colorChannel, timeRange, height = 340, xGrid, yGrid,
}: ScatterViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(700);
  const [hover, setHover] = useState<string | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, host.clientWidth)));
    ro.observe(host);
    setWidth(Math.max(320, host.clientWidth));
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

    // Collect points across all selected logs.
    interface Pt { x: number; y: number; c: number }
    const pts: Pt[] = [];
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    let cMin = Infinity, cMax = -Infinity;

    for (const log of logs) {
      const xc = log.byName.get(xChannel);
      const yc = log.byName.get(yChannel);
      if (!xc || !yc) continue;
      const cc = colorChannel ? log.byName.get(colorChannel) : undefined;
      for (let i = 0; i < log.rowCount; i++) {
        if (timeRange) {
          const t = log.time[i];
          if (t < timeRange[0] || t > timeRange[1]) continue;
        }
        const x = xc.values[i];
        const y = yc.values[i];
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        // Railed sentinels would stretch the colour ramp across a range the
        // real data never occupies, flattening every genuine difference.
        const raw = cc ? cc.values[i] : NaN;
        const c = cc && isPlausible(colorChannel, raw) ? raw : NaN;
        pts.push({ x, y, c });
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
        if (!Number.isNaN(c)) { if (c < cMin) cMin = c; if (c > cMax) cMax = c; }
      }
    }

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;

    if (pts.length === 0) {
      ctx.fillStyle = '#8b95a6';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('No samples in this window', width / 2, height / 2);
      return;
    }

    // Round the ranges outward a little so points are not clipped to the frame.
    const padRange = (lo: number, hi: number): [number, number] => {
      if (lo === hi) return [lo - 1, hi + 1];
      const p = (hi - lo) * 0.04;
      return [lo - p, hi + p];
    };
    [xMin, xMax] = padRange(xMin, xMax);
    [yMin, yMax] = padRange(yMin, yMax);

    const sx = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const sy = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // Frame and gridlines.
    ctx.strokeStyle = 'rgba(139,149,166,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD.left + 0.5, PAD.top + 0.5, plotW, plotH);

    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#8b95a6';

    const drawGrid = (values: number[] | undefined, axis: 'x' | 'y', fallbackCount: number) => {
      const ticks = values && values.length
        ? values
        : Array.from({ length: fallbackCount + 1 }, (_, i) =>
            axis === 'x' ? xMin + ((xMax - xMin) * i) / fallbackCount
                         : yMin + ((yMax - yMin) * i) / fallbackCount);
      ctx.strokeStyle = values && values.length
        ? 'rgba(139,149,166,0.24)'
        : 'rgba(139,149,166,0.11)';
      for (const t of ticks) {
        if (axis === 'x') {
          if (t < xMin || t > xMax) continue;
          const px = Math.round(sx(t)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(px, PAD.top);
          ctx.lineTo(px, PAD.top + plotH);
          ctx.stroke();
          ctx.textAlign = 'center';
          ctx.fillText(String(Math.round(t)), px, height - PAD.bottom + 14);
        } else {
          if (t < yMin || t > yMax) continue;
          const py = Math.round(sy(t)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(PAD.left, py);
          ctx.lineTo(PAD.left + plotW, py);
          ctx.stroke();
          ctx.textAlign = 'right';
          ctx.fillText(String(Math.round(t)), PAD.left - 6, py + 3);
        }
      }
    };
    drawGrid(xGrid, 'x', 8);
    drawGrid(yGrid, 'y', 6);

    // Points. Painted with light alpha so density reads as shading.
    const range = cMax - cMin;
    for (const p of pts) {
      ctx.fillStyle = colorChannel && !Number.isNaN(p.c) && range > 0
        ? heatColor((p.c - cMin) / range)
        : '#4ea1ff';
      ctx.globalAlpha = 0.5;
      ctx.fillRect(sx(p.x) - 1.5, sy(p.y) - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;

    // Axis titles.
    ctx.fillStyle = '#8b95a6';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(xChannel, PAD.left + plotW / 2, height - 4);
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yChannel, 0, 0);
    ctx.restore();

    setHover(
      colorChannel && range > 0
        ? `${pts.length} samples · ${colorChannel} ${cMin.toFixed(1)} → ${cMax.toFixed(1)}`
        : `${pts.length} samples`,
    );
  }, [logs, xChannel, yChannel, colorChannel, timeRange, width, height, xGrid, yGrid]);

  return (
    <div ref={hostRef}>
      <canvas ref={canvasRef} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">{hover}</span>
        {colorChannel && (
          <span className="legend-scale">
            low <span className="bar" /> high
          </span>
        )}
      </div>
    </div>
  );
}
