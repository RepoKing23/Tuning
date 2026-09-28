import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface DynoSeries {
  id: string;
  label: string;
  color: string;
  /** Sorted by x (rpm). */
  points: { x: number; y: number }[];
}

export interface DynoChartProps {
  series: DynoSeries[];
  /** Shared across the power and torque charts so they line up. */
  xDomain: [number, number];
  yLabel: string;
  unit: string;
  /** Rpm under the pointer, shared so both charts show the same crosshair. */
  hoverRpm: number | null;
  onHover(rpm: number | null): void;
  height?: number;
}

const PAD = { left: 52, right: 14, top: 10, bottom: 30 };

/** y at x on a polyline, or NaN outside it. */
export function valueAt(points: { x: number; y: number }[], x: number): number {
  if (points.length === 0 || x < points[0].x || x > points[points.length - 1].x) return NaN;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (x <= b.x) {
      const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * f;
    }
  }
  return points[points.length - 1].y;
}

/** A step of 1, 2 or 5 × 10ⁿ giving about `count` ticks. */
function niceStep(range: number, count: number): number {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/**
 * One measure against rpm, one line per pull — a dyno sheet.
 *
 * Power and torque are drawn as two charts sharing the rpm axis rather than as
 * one chart with two y-scales: a second scale lets the curves' crossing point
 * mean whatever the scales make it mean.
 */
export function DynoChart({
  series, xDomain, yLabel, unit, hoverRpm, onHover, height = 260,
}: DynoChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(700);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(300, host.clientWidth)));
    ro.observe(host);
    setWidth(Math.max(300, host.clientWidth));
    return () => ro.disconnect();
  }, []);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const [xMin, xMax] = xDomain;

  let yMaxData = 0;
  for (const s of series) for (const p of s.points) if (p.y > yMaxData) yMaxData = p.y;
  const yStep = niceStep(Math.max(1, yMaxData), 5);
  const yMax = Math.max(yStep, Math.ceil((yMaxData * 1.05) / yStep) * yStep);

  const sx = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const sy = (v: number) => PAD.top + plotH - (Math.max(0, v) / yMax) * plotH;

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

    // Recessive grid: it is there to read values off, not to be looked at.
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#8b95a6';
    ctx.strokeStyle = 'rgba(139,149,166,0.14)';
    ctx.lineWidth = 1;
    for (let y = 0; y <= yMax + 1e-9; y += yStep) {
      const py = Math.round(sy(y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.left, py); ctx.lineTo(PAD.left + plotW, py); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(y)), PAD.left - 6, py + 3);
    }
    const xStep = niceStep(xMax - xMin, Math.max(3, Math.floor(plotW / 80)));
    for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
      const px = Math.round(sx(x)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + plotH); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.round(x)), px, height - PAD.bottom + 14);
    }

    ctx.fillStyle = '#8b95a6';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('RPM', PAD.left + plotW / 2, height - 3);
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${yLabel} (${unit})`, 0, 0);
    ctx.restore();

    // 2px lines with round joins; each pull in its own fixed colour.
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of series) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
      ctx.stroke();
    }

    if (hoverRpm !== null && hoverRpm >= xMin && hoverRpm <= xMax) {
      const px = Math.round(sx(hoverRpm)) + 0.5;
      ctx.strokeStyle = 'rgba(223,228,236,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + plotH); ctx.stroke();
      for (const s of series) {
        const y = valueAt(s.points, hoverRpm);
        if (!Number.isFinite(y)) continue;
        // 2px surface ring keeps overlapping markers separable.
        ctx.beginPath();
        ctx.arc(sx(hoverRpm), sy(y), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#191d24';
        ctx.stroke();
      }
    }
  }, [series, width, height, xMin, xMax, yMax, yStep, hoverRpm, yLabel, unit, plotW, plotH]);

  const rpmFromEvent = (clientX: number): number | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    if (x < PAD.left || x > PAD.left + plotW) return null;
    return xMin + ((x - PAD.left) / plotW) * (xMax - xMin);
  };

  const readout = hoverRpm === null
    ? []
    : series
        .map((s) => ({ s, y: valueAt(s.points, hoverRpm) }))
        .filter((r) => Number.isFinite(r.y));

  return (
    <div ref={hostRef}>
      <canvas
        ref={canvasRef}
        style={{ touchAction: 'pan-y', cursor: 'crosshair', display: 'block' }}
        onPointerMove={(e) => onHover(rpmFromEvent(e.clientX))}
        onPointerDown={(e) => onHover(rpmFromEvent(e.clientX))}
        onPointerLeave={() => onHover(null)}
      />
      <div className="cursor-readout">
        {hoverRpm === null ? (
          <span className="muted">Hover the chart to read values at any rpm</span>
        ) : (
          <>
            <span className="item">{hoverRpm.toFixed(0)} rpm</span>
            {readout.length === 0 && <span className="muted">no pull covers this rpm</span>}
            {readout.map(({ s, y }) => (
              <span className="item" key={s.id}>
                <span className="dot" style={{ background: s.color }} />
                {s.label}
                <strong>{y.toFixed(1)}</strong>
                <span className="muted">{unit}</span>
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
