import { useMemo, useState } from 'react';
import { activeLogs, useProject } from '../state/project';
import { readTable } from '../lib/rom/readTable';
import { FileBar } from '../components/FileBar';
import { TableGrid, currentGrid } from '../components/tables/TableGrid';
import { CopyOut } from '../components/tables/CopyOut';
import { TableChart } from '../components/tables/TableChart';
import { binLog, DEFAULT_FILTER } from '../lib/tune/binning';

export function TablesPage() {
  const project = useProject();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showCoverage, setShowCoverage] = useState(true);

  const def = project.definition?.definition ?? null;
  const rom = project.rom?.bytes ?? null;
  const ready = !!def && !!rom && project.identity?.matches === true;

  const tables = useMemo(() => {
    if (!def) return [];
    const q = filter.trim().toLowerCase();
    const list = q
      ? def.tables.filter(
          (t) => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q),
        )
      : def.tables;
    return list;
  }, [def, filter]);

  const byCategory = useMemo(() => {
    const map = new Map<string, typeof tables>();
    for (const t of tables) {
      const arr = map.get(t.category) ?? [];
      arr.push(t);
      map.set(t.category, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tables]);

  const selected = useMemo(() => {
    if (!ready || !def || !rom) return null;
    const target = def.tables.find((t) => t.id === selectedId) ?? null;
    if (!target) return null;
    return readTable(rom, def, target);
  }, [ready, def, rom, selectedId]);

  const edits = selected ? project.edits[selected.def.id] ?? {} : {};

  // Sample counts per cell, so cells your logs never visited read as dimmed.
  const coverage = useMemo(() => {
    if (!selected || !showCoverage) return undefined;
    if (selected.def.dims !== '3D') return undefined;
    const logs = activeLogs(project);
    if (logs.length === 0) return undefined;

    const counts = selected.y.values.map(() => selected.x.values.map(() => 0));
    for (const { log, health } of logs) {
      const binned = binLog(log, {
        xAxis: selected.x.values,
        yAxis: selected.y.values,
        xChannel: 'Load',
        yChannel: 'RPM',
        collect: [],
        filter: DEFAULT_FILTER,
        ignoreCoolant: health.get('Cooltemp')?.status !== 'ok',
      });
      for (let r = 0; r < counts.length; r++) {
        for (let c = 0; c < counts[r].length; c++) counts[r][c] += binned.cells[r][c].n;
      }
    }
    return counts;
  }, [selected, showCoverage, project]);

  return (
    <div className="main">
      <aside className="sidebar wide">
        <FileBar />
        {def && (
          <div className="panel">
            <h2>Tables ({def.tables.length})</h2>
            <input
              type="text"
              placeholder="Filter by name or category…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: '100%', marginBottom: 8 }}
            />
            <div className="table-list">
              {byCategory.map(([category, list]) => (
                <div key={category}>
                  <div className="group-title">{category}</div>
                  {list.map((t) => (
                    <div
                      key={t.id}
                      className={`table-item${selectedId === t.id ? ' active' : ''}`}
                      title={`${t.name}\n0x${t.address.toString(16)} · ${t.dims} · ${t.scaling}`}
                      onClick={() => setSelectedId(t.id)}
                    >
                      {t.name}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      <main className="content">
        {!def || !rom ? (
          <div className="notice info">
            <strong>Load a ROM and its definition</strong>
            The table editor needs both the EcuFlash <code>.xml</code> definition and the{' '}
            <code>.bin</code> it describes.
          </div>
        ) : !project.identity?.matches ? (
          <div className="notice bad">
            <strong>Definition does not match this ROM</strong>
            {project.identity?.message}
            <div style={{ marginTop: 6 }}>
              Tables are hidden because reading at the wrong addresses produces numbers that look
              plausible and are entirely wrong.
            </div>
          </div>
        ) : !selected ? (
          <div className="notice info">
            <strong>Pick a table</strong>
            Choose one from the list on the left. Try <code>High Octane Spark Map</code> or{' '}
            <code>MAF CALIBRATION Part 1</code>.
          </div>
        ) : (
          <>
            <div className="panel">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <strong>{selected.def.name}</strong>
                  <div className="muted small mono">
                    0x{selected.def.address.toString(16)} · {selected.def.dims} ·{' '}
                    {selected.ny} × {selected.nx} · {selected.scaling.storagetype}
                    {selected.def.swapxy ? ' · swapxy' : ''}
                    {selected.units ? ` · ${selected.units}` : ''}
                  </div>
                </div>
                <div className="row">
                  {selected.def.dims === '3D' && (
                    <label className="row small muted" style={{ gap: 5 }}>
                      <input
                        type="checkbox"
                        checked={showCoverage}
                        onChange={(e) => setShowCoverage(e.target.checked)}
                      />
                      dim unlogged cells
                    </label>
                  )}
                  {Object.keys(edits).length > 0 && (
                    <button onClick={() => project.clearEdits(selected.def.id)}>
                      Revert {Object.keys(edits).length} edit(s)
                    </button>
                  )}
                  <CopyOut table={selected} edits={edits} />
                </div>
              </div>

              <TableGrid
                table={selected}
                edits={edits}
                coverage={coverage}
                onEdit={(r, c, v) => project.setEdit(selected.def.id, r, c, v)}
              />
              <div className="muted small" style={{ marginTop: 6 }}>
                Double-click a cell to edit. Values are quantised to what the ECU can actually
                store. Copy pastes as TSV straight into EcuFlash.
              </div>
            </div>

            <div className="panel">
              <h2>Curve</h2>
              <TableChart table={selected} values={currentGrid(selected, edits)} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
