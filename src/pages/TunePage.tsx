import { useMemo, useState } from 'react';
import { activeLogs, useProject } from '../state/project';
import { readTable } from '../lib/rom/readTable';
import type { TableData } from '../lib/rom/readTable';
import { FileBar } from '../components/FileBar';
import { TableGrid, currentGrid } from '../components/tables/TableGrid';
import { CopyOut } from '../components/tables/CopyOut';
import { TableChart } from '../components/tables/TableChart';
import { ExplainPanel } from '../components/tune/ExplainPanel';
import { recommendMaf, DEFAULT_MAF_OPTIONS } from '../lib/tune/maf';
import { recommendTiming } from '../lib/tune/timing';
import { OVERRUN_TABLE_HINTS, PROFILES, MIN_SAMPLES, snapWindow } from '../lib/tune/profiles';
import type { OverrunWindow, ProfileId } from '../lib/tune/profiles';
import { OverrunWindowPicker } from '../components/tune/OverrunWindowPicker';
import { binLog, DEFAULT_FILTER } from '../lib/tune/binning';
import { blocked } from '../lib/tune/types';
import { analyseAfr, recommendFuelMap, DEFAULT_AFR_OPTIONS } from '../lib/tune/afr';
import { AfrDiagnosis } from '../components/tune/AfrDiagnosis';
import { KnockAssistant } from '../components/tune/KnockAssistant';
import { analyseKnock, recommendKnockRetard, recommendNoiseFloor } from '../lib/tune/knock';
import { detectLoadScale } from '../lib/log/loadScale';
import { getTempUnit } from '../lib/log/prefs';

type Target = 'maf' | 'timing' | 'afr' | 'knock';

const MAF_PARTS = [
  'MAF CALIBRATION Part 1  (units)',
  'MAF CALIBRATION Part 2  (units)',
  'MAF CALIBRATION Part 3  (units)',
];

export interface TunePageProps {
  /** Jump to a table in the ROM Tables tab. */
  onOpenTable?(name: string): void;
}

const FUEL_MAP = 'Fuel Calibration Map';
const AFR_MAP = 'AFR Map warm';
const KNOCK_THRESHOLD = 'Knock Control, Active Load Threshold';
const NOISE_TABLES = [
  'Knock Sensitivity, Background Noise Adder (Single Gain #1)',
  'Knock Sensitivity, Background Noise Adder (Single Gain #2)',
  'Knock Sensitivity, Background Noise Adder (Triple Gain #1)',
  'Knock Sensitivity, Background Noise Adder (Triple Gain #2)',
];

export function TunePage({ onOpenTable }: TunePageProps = {}) {
  const project = useProject();
  const logs = activeLogs(project);

  const [target, setTarget] = useState<Target>('timing');
  const [profile, setProfile] = useState<ProfileId>('eco');
  const [intensity, setIntensity] = useState(1);
  const [minSamples, setMinSamples] = useState(MIN_SAMPLES);
  const [mafPart, setMafPart] = useState(MAF_PARTS[0]);
  const [sparkTableName, setSparkTableName] = useState('High Octane Spark Map');
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [overrunWindow, setOverrunWindow] = useState<OverrunWindow | null>(null);
  const [knockMode, setKnockMode] = useState<'retard' | 'noiseFloor'>('retard');
  const [noiseTable, setNoiseTable] = useState(NOISE_TABLES[0]);
  const tempUnit = getTempUnit();

  const def = project.definition?.definition ?? null;
  const rom = project.rom?.bytes ?? null;
  const ready = !!def && !!rom && project.identity?.matches === true;

  const sparkTables = useMemo(
    () => (def ? def.tables.filter((t) => t.category === 'SPARK' && t.dims === '3D') : []),
    [def],
  );

  const table: TableData | null = useMemo(() => {
    if (!ready || !def || !rom) return null;
    const name =
      target === 'maf' ? mafPart
      : target === 'afr' ? FUEL_MAP
      : target === 'knock' ? (knockMode === 'noiseFloor' ? noiseTable : sparkTableName)
      : sparkTableName;
    const found = def.tables.find((t) => t.name === name);
    return found ? readTable(rom, def, found) : null;
  }, [ready, def, rom, target, mafPart, sparkTableName, knockMode, noiseTable]);

  const tableByName = useMemo(() => {
    if (!ready || !def || !rom) return () => null;
    return (name: string) => {
      const t = def.tables.find((x) => x.name === name);
      return t ? readTable(rom, def, t) : null;
    };
  }, [ready, def, rom]);

  /**
   * The logger and the definition can disagree about load scaling, and when
   * they do every cell attribution lands in the wrong column. Derived once here
   * and threaded through every analysis.
   */
  const loadScale = useMemo(
    () => detectLoadScale(logs.map((l) => l.log), tableByName(AFR_MAP)),
    [logs, tableByName],
  );

  const mafTables = useMemo(() => {
    if (!ready || !def || !rom) return [];
    return MAF_PARTS
      .map((n) => def.tables.find((t) => t.name === n))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => readTable(rom, def, t));
  }, [ready, def, rom]);

  const knockOptions = useMemo(() => ({
    loadScale: loadScale.factor,
    activeLoadThreshold: tableByName(KNOCK_THRESHOLD),
    maxRetardDeg: 6,
  }), [loadScale, tableByName]);

  const knockAnalysis = useMemo(() => {
    if (target !== 'knock' || logs.length === 0) return null;
    return analyseKnock(logs.map(({ log, health }) => ({ log, health })), knockOptions);
  }, [target, logs, knockOptions]);

  const afrAnalysis = useMemo(() => {
    if (target !== 'afr' || !table || logs.length === 0) return null;
    return analyseAfr(
      logs.map(({ log, health }) => ({ log, health })),
      mafTables,
      table,
      { ...DEFAULT_AFR_OPTIONS, minSamples, loadScale: loadScale.factor },
    );
  }, [target, table, logs, mafTables, minSamples, loadScale]);

  const recommendation = useMemo(() => {
    if (!table) return blocked('Load a ROM, its definition and a datalog to get suggestions.');
    if (logs.length === 0) return blocked('No logs selected. Tick at least one in the Files panel.');
    const inputs = logs.map(({ log, health }) => ({ log, health }));
    if (target === 'maf') return recommendMaf(inputs, table, { ...DEFAULT_MAF_OPTIONS, minSamples });
    if (target === 'afr') {
      return recommendFuelMap(inputs, mafTables, table, {
        ...DEFAULT_AFR_OPTIONS, minSamples, loadScale: loadScale.factor,
      });
    }
    if (target === 'knock') {
      return knockMode === 'noiseFloor'
        ? recommendNoiseFloor(inputs, table, knockOptions)
        : recommendKnockRetard(inputs, table, knockOptions);
    }
    return recommendTiming(inputs, table, {
      profile, minSamples, intensity, timeRange: null, overrunWindow,
      loadScale: loadScale.factor,
    });
  }, [table, logs, target, profile, intensity, minSamples, overrunWindow, mafTables,
      loadScale, knockMode, knockOptions]);

  const healthNotes = useMemo(
    () =>
      logs.flatMap(({ log, health }) =>
        [...health.values()]
          .filter((h) => h.status !== 'ok')
          .map((h) => `${log.name} · ${h.name} (${h.status}): ${h.reasons[0] ?? ''}`),
      ),
    [logs],
  );

  const edits = table ? project.edits[table.def.id] ?? {} : {};
  const activeProfile = PROFILES[profile];

  const coverage = useMemo(() => {
    if (!table || table.def.dims !== '3D' || logs.length === 0) return undefined;
    const counts = table.y.values.map(() => table.x.values.map(() => 0));
    for (const { log, health } of logs) {
      const binned = binLog(log, {
        xAxis: table.x.values,
        yAxis: table.y.values,
        xChannel: 'Load',
        yChannel: 'RPM',
        collect: [],
        filter: DEFAULT_FILTER,
        xScale: loadScale.factor,
        ignoreCoolant: health.get('Cooltemp')?.status !== 'ok',
      });
      for (let r = 0; r < counts.length; r++) {
        for (let c = 0; c < counts[r].length; c++) counts[r][c] += binned.cells[r][c].n;
      }
    }
    return counts;
  }, [table, logs]);

  const applySuggestions = (onlyConfident: boolean) => {
    if (!table) return;
    for (const [key, s] of recommendation.suggestions) {
      if (onlyConfident && s.confidence < 0.5) continue;
      const [r, c] = key.split(',').map(Number);
      project.setEdit(table.def.id, r, c, s.value);
    }
  };

  return (
    <div className="main">
      <aside className="sidebar wide">
        <FileBar />

        <div className="panel">
          <h2>What to tune</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className={target === 'timing' ? 'primary' : ''} onClick={() => setTarget('timing')}>
              Timing advance
            </button>
            <button className={target === 'maf' ? 'primary' : ''} onClick={() => setTarget('maf')}>
              MAF scaling
            </button>
            <button className={target === 'afr' ? 'primary' : ''} onClick={() => setTarget('afr')}>
              AFR / fuelling
            </button>
            <button className={target === 'knock' ? 'primary' : ''} onClick={() => setTarget('knock')}>
              Knock
            </button>
          </div>

          {target === 'knock' ? (
            <div className="muted small">
              Separates real knock from the sensor mishearing mechanical noise, then routes each
              to the table that actually fixes it.
            </div>
          ) : target === 'afr' ? (
            <div className="muted small">
              Compares your wideband against the ECU's own commanded target, works out which
              table is responsible, and writes the operating-point part into the{' '}
              <strong>{FUEL_MAP}</strong>.
            </div>
          ) : target === 'maf' ? (
            <label className="small">
              MAF table part
              <select
                value={mafPart}
                onChange={(e) => setMafPart(e.target.value)}
                style={{ width: '100%', marginTop: 4 }}
              >
                {MAF_PARTS.map((p) => <option key={p} value={p}>{p.replace('  (units)', '')}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label className="small">
                Spark map
                <select
                  value={sparkTableName}
                  onChange={(e) => setSparkTableName(e.target.value)}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  {sparkTables.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </label>

              <div className="group-title">Tune character</div>
              {(Object.keys(PROFILES) as ProfileId[]).map((id) => (
                <label className="channel" key={id}>
                  <input
                    type="radio"
                    name="profile"
                    checked={profile === id}
                    onChange={() => {
                      setProfile(id);
                      setOverrunWindow(PROFILES[id].defaultWindow ?? null);
                    }}
                  />
                  <span className="name">{PROFILES[id].label}</span>
                  {PROFILES[id].warning && <span className="badge dead">risk</span>}
                </label>
              ))}
              <div className="muted small" style={{ marginTop: 6 }}>{activeProfile.description}</div>

              {activeProfile.overrun && table && table.def.dims === '3D' && (
                <OverrunWindowPicker
                  rpmAxis={table.y.values}
                  loadAxis={table.x.values}
                  value={snapWindow(
                    overrunWindow ?? activeProfile.defaultWindow!,
                    table.y.values,
                    table.x.values,
                  )}
                  onChange={setOverrunWindow}
                  onReset={() => setOverrunWindow(activeProfile.defaultWindow ?? null)}
                  coverage={coverage}
                />
              )}

              <label className="small" style={{ display: 'block', marginTop: 10 }}>
                Intensity: {intensity.toFixed(1)}×
                <input
                  type="range"
                  min={0.2}
                  max={1.5}
                  step={0.1}
                  value={intensity}
                  onChange={(e) => setIntensity(Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </label>
            </>
          )}

          <label className="small" style={{ display: 'block', marginTop: 8 }}>
            Minimum samples per cell: {minSamples}
            <input
              type="range"
              min={4}
              max={120}
              step={2}
              value={minSamples}
              onChange={(e) => setMinSamples(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
        </div>
      </aside>

      <main className="content">
        {!ready ? (
          <div className="notice info">
            <strong>Load a ROM and definition first</strong>
            Suggestions are computed against the real table values in your <code>.bin</code>, so
            the AI tuning tab needs both it and the matching EcuFlash <code>.xml</code>.
          </div>
        ) : (
          <>
            {loadScale.factor !== 1 && (
              <div className="notice warn">
                <strong>Load rescaled to match the ROM</strong>
                {loadScale.message}
              </div>
            )}

            {target === 'knock' && knockAnalysis && (
              <KnockAssistant
                analysis={knockAnalysis}
                tempUnit={tempUnit}
                mode={knockMode}
                onModeChange={setKnockMode}
                onOpenTable={(n) => onOpenTable?.(n)}
                noiseTables={NOISE_TABLES}
                noiseTable={noiseTable}
                onNoiseTableChange={setNoiseTable}
              />
            )}

            {target === 'afr' && afrAnalysis && (
              <AfrDiagnosis
                analysis={afrAnalysis}
                onOpenTable={(name) => onOpenTable?.(name)}
              />
            )}

            {target === 'timing' && activeProfile.warning && (
              <div className="notice bad">
                <strong>{activeProfile.label}: read this first</strong>
                {activeProfile.warning}
              </div>
            )}

            <div className={`notice ${recommendation.status === 'blocked' ? 'warn' : 'good'}`}>
              <strong>
                {recommendation.status === 'blocked' ? 'Cannot suggest values' : 'Suggestions ready'}
              </strong>
              {recommendation.message}
              {recommendation.notes.length > 0 && (
                <ul>{recommendation.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              )}
            </div>

            {table && (
              <>
                <div className="panel">
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                    <div>
                      <strong>{table.def.name}</strong>
                      <div className="muted small mono">
                        {table.ny} × {table.nx}
                        {table.units ? ` · ${table.units}` : ''} ·{' '}
                        {recommendation.suggestions.size} suggested ·{' '}
                        {recommendation.starved} cells short of data
                      </div>
                    </div>
                    <div className="row">
                      <label className="row small" style={{ gap: 5 }}>
                        <input
                          type="checkbox"
                          checked={showSuggestions}
                          onChange={(e) => setShowSuggestions(e.target.checked)}
                        />
                        show AI recommendations
                      </label>
                      <button
                        onClick={() => applySuggestions(true)}
                        disabled={recommendation.suggestions.size === 0}
                      >
                        Apply confident only
                      </button>
                      <button
                        onClick={() => applySuggestions(false)}
                        disabled={recommendation.suggestions.size === 0}
                      >
                        Apply all
                      </button>
                      {Object.keys(edits).length > 0 && (
                        <button onClick={() => project.clearEdits(table.def.id)}>
                          Revert {Object.keys(edits).length}
                        </button>
                      )}
                      <CopyOut
                        table={table}
                        edits={edits}
                        suggestions={recommendation.suggestions}
                        showSuggestions={showSuggestions}
                      />
                    </div>
                  </div>

                  <TableGrid
                    table={table}
                    edits={edits}
                    suggestions={recommendation.suggestions}
                    showSuggestions={showSuggestions}
                    onEdit={(r, c, v) => project.setEdit(table.def.id, r, c, v)}
                  />
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Amber-outlined cells are suggestions. Hover any cell for the sample count,
                    knock count, confidence and the reason behind the change. Copy pastes as TSV
                    straight into EcuFlash — this app never writes a <code>.bin</code>.
                  </div>
                </div>

                <div className="panel">
                  <h2>Current vs suggested</h2>
                  <TableChart
                    table={table}
                    values={currentGrid(table, edits)}
                    overlay={
                      showSuggestions && recommendation.suggestions.size > 0
                        ? currentGrid(table, edits, recommendation.suggestions)
                        : null
                    }
                  />
                </div>

                {target === 'timing' && PROFILES[profile].overrun && (
                  <div className="panel">
                    <h2>Also needed for {PROFILES[profile].label}</h2>
                    <div className="muted small" style={{ marginBottom: 8 }}>
                      Spark retard is only half of it. These tables control whether there is still
                      fuel in the exhaust to burn. They are not edited automatically because
                      getting them wrong causes stalling and hesitation rather than noise.
                    </div>
                    {OVERRUN_TABLE_HINTS.map((hint) => {
                      const count = def?.tables.filter((t) => t.category === hint.category).length ?? 0;
                      return (
                        <div key={hint.category} style={{ marginBottom: 8 }}>
                          <strong className="small">{hint.category}</strong>{' '}
                          <span className="muted small">({count} tables in your ROM)</span>
                          <div className="muted small">{hint.guidance}</div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <ExplainPanel
                  table={table}
                  recommendation={recommendation}
                  profile={target === 'timing' ? profile : undefined}
                  healthNotes={healthNotes}
                />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
