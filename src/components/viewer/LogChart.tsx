import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { LogFile } from '../../lib/log/types';
import { colorFor } from '../../lib/log/palette';

export interface LogChartProps {
  log: LogFile;
  /** Channel names to draw, in order. */
  visible: string[];
  /** Channel whose scale owns the left axis. */
  focused: string | null;
  /** Reported on every cursor move so the sidebar can show live values. */
  onCursor?: (rowIndex: number | null) => void;
  /** Current x-range, so the overview strip and parent stay in sync. */
  onZoom?: (range: [number, number] | null) => void;
  height?: number;
}

/**
 * Scroll-wheel zoom about the cursor, plus shift-drag panning.
 *
 * uPlot ships drag-to-zoom and double-click reset; wheel zoom and pan are the
 * two gestures a long log really needs and are not built in.
 */
function zoomPlugin(): uPlot.Plugin {
  return {
    hooks: {
      ready: (u) => {
        const over = u.over;
        const clampToData = (min: number, max: number): [number, number] => {
          const lo = u.data[0][0] as number;
          const hi = u.data[0][u.data[0].length - 1] as number;
          const span = Math.min(max - min, hi - lo);
          let a = Math.max(lo, min);
          let b = a + span;
          if (b > hi) { b = hi; a = b - span; }
          return [a, Math.max(a + 1e-6, b)];
        };

        over.addEventListener('wheel', (e: WheelEvent) => {
          e.preventDefault();
          const rect = over.getBoundingClientRect();
          const cursorX = (e.clientX - rect.left) / rect.width;
          const { min, max } = u.scales.x;
          if (min == null || max == null) return;
          const factor = e.deltaY > 0 ? 1.25 : 0.8;
          const anchor = min + (max - min) * cursorX;
          const nextMin = anchor - (anchor - min) * factor;
          const nextMax = anchor + (max - anchor) * factor;
          const [a, b] = clampToData(nextMin, nextMax);
          u.setScale('x', { min: a, max: b });
        }, { passive: false });

        let panning: { clientX: number; min: number; max: number } | null = null;
        over.addEventListener('mousedown', (e: MouseEvent) => {
          if (!e.shiftKey && e.button !== 1) return;
          e.preventDefault();
          const { min, max } = u.scales.x;
          if (min == null || max == null) return;
          panning = { clientX: e.clientX, min, max };
        });
        window.addEventListener('mousemove', (e: MouseEvent) => {
          if (!panning) return;
          const rect = over.getBoundingClientRect();
          const span = panning.max - panning.min;
          const shift = ((panning.clientX - e.clientX) / rect.width) * span;
          const [a, b] = clampToData(panning.min + shift, panning.max + shift);
          u.setScale('x', { min: a, max: b });
        });
        window.addEventListener('mouseup', () => { panning = null; });
      },
    },
  };
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function LogChart({ log, visible, focused, onCursor, onZoom, height = 420 }: LogChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [width, setWidth] = useState(900);

  // Track the container width so the plot fills the pane and follows resizes.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, host.clientWidth)));
    ro.observe(host);
    setWidth(Math.max(320, host.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // uPlot treats null as a gap; typed arrays cannot carry it, so unlogged
    // samples are converted here rather than being drawn as zeros.
    const x = Array.from(log.time);
    const series: uPlot.Series[] = [{ label: 'time', value: (_u, v) => fmtTime(v) }];
    const cols: (number | null)[][] = [];

    for (const name of visible) {
      const ch = log.byName.get(name);
      if (!ch) continue;
      const col: (number | null)[] = new Array(ch.values.length);
      for (let i = 0; i < ch.values.length; i++) {
        const v = ch.values[i];
        col[i] = Number.isNaN(v) ? null : v;
      }
      cols.push(col);
      series.push({
        label: name,
        scale: name,
        stroke: colorFor(name),
        width: name === focused ? 2 : 1.25,
        points: { show: false },
        spanGaps: false,
      });
    }

    const plotData = [x, ...cols] as unknown as uPlot.AlignedData;

    const axes: uPlot.Axis[] = [
      {
        stroke: '#8b95a6',
        grid: { stroke: 'rgba(139,149,166,0.13)', width: 1 },
        ticks: { stroke: 'rgba(139,149,166,0.25)' },
        values: (_u, splits) => splits.map((s) => fmtTime(s)),
      },
    ];
    if (focused && visible.includes(focused)) {
      const ch = log.byName.get(focused);
      axes.push({
        scale: focused,
        stroke: colorFor(focused),
        grid: { stroke: 'rgba(139,149,166,0.09)', width: 1 },
        ticks: { stroke: 'rgba(139,149,166,0.2)' },
        label: `${focused}${ch?.unit ? ` (${ch.unit})` : ''}`,
        labelSize: 18,
        labelFont: '11px system-ui',
      });
    }

    const opts: uPlot.Options = {
      width,
      height,
      series,
      axes,
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false },
        focus: { prox: 24 },
        points: { show: true },
      },
      scales: { x: { time: false } },
      plugins: [zoomPlugin()],
      hooks: {
        setCursor: [
          (u) => {
            onCursor?.(u.cursor.idx ?? null);
          },
        ],
        setScale: [
          (u, key) => {
            if (key !== 'x') return;
            const { min, max } = u.scales.x;
            onZoom?.(min == null || max == null ? null : [min, max]);
          },
        ],
      },
    };

    // Pad each channel's own scale so flat traces do not sit on the frame.
    for (const name of visible) {
      opts.scales![name] = {
        auto: true,
        range: (_u, dataMin, dataMax) => {
          if (dataMin == null || dataMax == null) return [0, 1];
          if (dataMin === dataMax) return [dataMin - 1, dataMax + 1];
          const pad = (dataMax - dataMin) * 0.06;
          return [dataMin - pad, dataMax + pad];
        },
      };
    }

    const plot = new uPlot(opts, plotData, host);
    plotRef.current = plot;
    return () => { plot.destroy(); plotRef.current = null; };
    // `data` is intentionally excluded: it is derived from log/visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, visible.join('|'), focused, width, height]);

  return (
    <div>
      <div ref={hostRef} />
      <div className="chart-hint">
        Drag to zoom a time range · scroll to zoom around the cursor · shift-drag to pan ·
        double-click to reset
      </div>
    </div>
  );
}

export { fmtTime };
