import { useMemo, useState } from 'react';
import { activeLogs, useProject } from '../state/project';
import { readTable } from '../lib/rom/readTable';
import { LogChart } from '../components/viewer/LogChart';
import { ChannelPanel } from '../components/viewer/ChannelPanel';
import { ScatterView } from '../components/viewer/ScatterView';
import { CellCoverage } from '../components/viewer/CellCoverage';
import type { CoverageMode } from '../components/viewer/CellCoverage';
import { FileBar } from '../components/FileBar';
import { colorFor } from '../lib/log/palette';
import { HealthSummary } from '../components/viewer/HealthSummary';

const DEFAULT_VISIBLE = ['RPM', 'Load', 'TimingAdv', 'MAF_Voltage'];

/** Axes used for the coverage grid when no ROM is loaded to supply real ones. */
const FALLBACK_LOAD = [10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 100, 260];
const FALLBACK_RPM = [
  500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750,
  3000, 3250, 3500, 3750, 4000, 4500, 5000, 5500, 6000, 6500,
];

export function ViewerPage() {
  const project = useProject();
  const selected = activeLogs(project);
  const primary = selected[0] ?? null;

  const [visible, setVisible] = useState<string[]>(DEFAULT_VISIBLE);
  const [focused, setFocused] = useState<string | null>('RPM');
  const [cursorRow, setCursorRow] = useState<number | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [colorChannel, setColorChannel] = useState('TimingAdv');
  const [mode, setMode] = useState<CoverageMode>('count');
  const [statChannel, setStatChannel] = useState('TimingAdv');

  // Prefer the spark map's real axes so the coverage grid matches the table
  // you will actually be editing.
  const axes = useMemo(() => {
    const def = project.definition?.definition;
    const rom = project.rom?.bytes;
    if (def && rom && project.identity?.matches) {
      const spark = def.tables.find((t) => t.name === 'High Octane Spark Map');
      if (spark) {
        const t = readTable(rom, def, spark);
        return { x: t.x.values, y: t.y.values, xLabel: t.x.name, yLabel: t.y.name, fromRom: true };
      }
    }
    return { x: FALLBACK_LOAD, y: FALLBACK_RPM, xLabel: 'Load', yLabel: 'RPM', fromRom: false };
  }, [project.definition, project.rom, project.identity]);

  const numericChannels = primary
    ? primary.log.channels.map((c) => c.name)
    : [];

  const ignoreCoolant = primary
    ? primary.health.get('Cooltemp')?.status !== 'ok'
    : true;

  return (
    <div className="main">
      <aside className="sidebar">
        <FileBar />
        {primary && (
          <div className="panel">
            <h2>Channels — {primary.log.name}</h2>
            <ChannelPanel
              log={primary.log}
              health={primary.health}
              visible={visible}
              focused={focused}
              cursorRow={cursorRow}
              onToggle={(name) =>
                setVisible((v) => (v.includes(name) ? v.filter((n) => n !== name) : [...v, name]))
              }
              onFocus={setFocused}
              onSetVisible={setVisible}
            />
          </div>
        )}
      </aside>

      <main className="content">
        {!primary ? (
          <div className="notice info">
            <strong>Load a log to begin</strong>
            Drop an EvoScan <code>.csv</code> in the panel on the left. Add your EcuFlash{' '}
            <code>.xml</code> definition and <code>.bin</code> to unlock the table editor and the
            AI tuning tab.
          </div>
        ) : (
          <>
            <HealthSummary log={primary.log} health={primary.health} />

            <div className="chart-wrap" style={{ marginBottom: 12 }}>
              <LogChart
                log={primary.log}
                visible={visible}
                focused={focused}
                onCursor={setCursorRow}
                onZoom={setZoom}
              />
              <div className="cursor-readout">
                {visible.length === 0 && <span className="muted">No channels selected</span>}
                {visible.map((name) => {
                  const ch = primary.log.byName.get(name);
                  if (!ch) return null;
                  const v = cursorRow !== null ? ch.values[cursorRow] : NaN;
                  return (
                    <span className="item" key={name}>
                      <span className="dot" style={{ background: colorFor(name) }} />
                      {name}
                      <strong>{Number.isNaN(v) ? '—' : v.toFixed(2).replace(/\.00$/, '')}</strong>
                      <span className="muted">{ch.unit}</span>
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="split">
              <div className="panel">
                <h2>Operating points — {axes.yLabel} vs {axes.xLabel}</h2>
                <div className="row" style={{ marginBottom: 8 }}>
                  <label className="muted small">Colour by</label>
                  <select value={colorChannel} onChange={(e) => setColorChannel(e.target.value)}>
                    <option value="">(none)</option>
                    {numericChannels.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  {zoom && (
                    <span className="muted small">
                      window {zoom[0].toFixed(1)}–{zoom[1].toFixed(1)}s
                    </span>
                  )}
                </div>
                <ScatterView
                  logs={selected.map((l) => l.log)}
                  xChannel="RPM"
                  yChannel="Load"
                  colorChannel={colorChannel}
                  timeRange={zoom}
                  xGrid={axes.y}
                  yGrid={axes.x}
                />
              </div>

              <div className="panel">
                <h2>
                  Cell coverage {axes.fromRom ? '(High Octane Spark Map axes)' : '(default 4B11 axes)'}
                </h2>
                <div className="row" style={{ marginBottom: 8 }}>
                  <select value={mode} onChange={(e) => setMode(e.target.value as CoverageMode)}>
                    <option value="count">Sample count</option>
                    <option value="median">Median of…</option>
                    <option value="mean">Mean of…</option>
                    <option value="max">Max of…</option>
                    <option value="knock">Knock counts</option>
                  </select>
                  {mode !== 'count' && mode !== 'knock' && (
                    <select value={statChannel} onChange={(e) => setStatChannel(e.target.value)}>
                      {numericChannels.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  )}
                </div>
                <CellCoverage
                  logs={selected.map((l) => l.log)}
                  xAxis={axes.x}
                  yAxis={axes.y}
                  xLabel={axes.xLabel}
                  yLabel={axes.yLabel}
                  xChannel="Load"
                  yChannel="RPM"
                  mode={mode}
                  statChannel={statChannel}
                  timeRange={zoom}
                  ignoreCoolant={ignoreCoolant}
                />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
