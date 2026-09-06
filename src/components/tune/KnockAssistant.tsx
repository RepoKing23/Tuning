import { useState } from 'react';
import type { KnockAnalysis, KnockEvent } from '../../lib/tune/knock';
import { formatTemp } from '../../lib/log/channelMeta';
import type { TempUnit } from '../../lib/log/channelMeta';

export interface KnockAssistantProps {
  analysis: KnockAnalysis;
  tempUnit: TempUnit;
  /** Which fix path is being written into the grid below. */
  mode: 'retard' | 'noiseFloor';
  onModeChange(mode: 'retard' | 'noiseFloor'): void;
  onOpenTable(name: string): void;
  /** Table names available for the phantom fix, in this ROM. */
  noiseTables: string[];
  noiseTable: string;
  onNoiseTableChange(name: string): void;
}

const VERDICT_CLASS = { real: 'dead', phantom: 'ok', uncertain: 'suspect' } as const;

function EventRow({ e, tempUnit }: { e: KnockEvent; tempUnit: TempUnit }) {
  return (
    <tr>
      <td style={{ textAlign: 'left' }}>
        <span className={`badge ${VERDICT_CLASS[e.verdict]}`}>{e.verdict}</span>
      </td>
      <td>{e.time.toFixed(1)}s</td>
      <td>+{e.counts}</td>
      <td>{Number.isFinite(e.intensity) ? e.intensity.toFixed(0) : '—'}</td>
      <td>{Number.isFinite(e.rpm) ? e.rpm.toFixed(0) : '—'}</td>
      <td>{Number.isFinite(e.load) ? e.load.toFixed(0) : '—'}</td>
      <td>{Number.isFinite(e.timing) ? `${e.timing.toFixed(0)}°` : '—'}</td>
      <td>{formatTemp(e.coolant, tempUnit)}</td>
      <td style={{ textAlign: 'left', whiteSpace: 'normal', minWidth: 220 }} className="muted">
        {e.reasons[0] ?? ''}
      </td>
    </tr>
  );
}

/**
 * Real knock and phantom knock need opposite fixes, so the verdict has to be
 * visible before any number is. A tuner who pulls timing to chase mechanical
 * noise loses power and still has the noise.
 */
export function KnockAssistant({
  analysis, tempUnit, mode, onModeChange, onOpenTable,
  noiseTables, noiseTable, onNoiseTableChange,
}: KnockAssistantProps) {
  const [showAll, setShowAll] = useState(false);

  if (analysis.status === 'blocked') {
    return (
      <div className="notice warn">
        <strong>Cannot analyse knock</strong>
        {analysis.message}
        {analysis.notes.length > 0 && <ul>{analysis.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </div>
    );
  }

  if (analysis.events.length === 0) {
    return (
      <div className="notice good">
        <strong>No knock recorded</strong>
        {analysis.notes[0]}
      </div>
    );
  }

  const shown = showAll ? analysis.events : analysis.events.slice(0, 12);

  return (
    <div className="panel">
      <h2>Knock</h2>

      <div className="stat-row">
        <div className="stat">
          <div className="muted small">Real knock</div>
          <div className="stat-value" style={{ color: analysis.realCount ? 'var(--bad)' : 'var(--ok)' }}>
            {analysis.realCount}
          </div>
          <div className="muted small">combustion — fix with timing</div>
        </div>
        <div className="stat">
          <div className="muted small">Phantom</div>
          <div className="stat-value" style={{ color: 'var(--accent)' }}>{analysis.phantomCount}</div>
          <div className="muted small">sensor noise — fix with sensitivity</div>
        </div>
        <div className="stat">
          <div className="muted small">Uncertain</div>
          <div className="stat-value" style={{ color: 'var(--warn)' }}>{analysis.uncertainCount}</div>
          <div className="muted small">evidence split both ways</div>
        </div>
      </div>

      <div className="group-title">Which fix to apply</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          className={mode === 'retard' ? 'primary' : ''}
          onClick={() => onModeChange('retard')}
          disabled={analysis.realCount === 0}
        >
          Pull timing where knock is real
        </button>
        <button
          className={mode === 'noiseFloor' ? 'primary' : ''}
          onClick={() => onModeChange('noiseFloor')}
          disabled={analysis.phantomCount === 0}
        >
          Raise the noise floor where it is phantom
        </button>
      </div>

      {mode === 'noiseFloor' && (
        <div className="row small" style={{ marginBottom: 8 }}>
          <label className="muted">Sensitivity table</label>
          <select
            value={noiseTable}
            onChange={(e) => onNoiseTableChange(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          >
            {noiseTables.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="small" onClick={() => onOpenTable(noiseTable)}>Open</button>
        </div>
      )}

      {analysis.phantomRpmBands.length > 0 && (
        <div className="muted small" style={{ marginBottom: 8 }}>
          Phantom events cluster near{' '}
          {analysis.phantomRpmBands.map((b) => `${b.rpm} rpm (${b.events})`).join(', ')}.
        </div>
      )}

      <div className="grid-scroll" style={{ marginTop: 4 }}>
        <table className="tune events">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Verdict</th>
              <th>Time</th><th>Counts</th><th>Signal</th><th>RPM</th>
              <th>Load</th><th>Timing</th><th>Coolant</th>
              <th style={{ textAlign: 'left' }}>Why</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e, i) => <EventRow key={`${e.logName}-${e.time}-${i}`} e={e} tempUnit={tempUnit} />)}
          </tbody>
        </table>
      </div>

      {analysis.events.length > 12 && (
        <button className="small" style={{ marginTop: 8 }} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${analysis.events.length} events`}
        </button>
      )}

      {analysis.notes.length > 0 && (
        <ul className="muted small" style={{ marginTop: 10, paddingLeft: 18 }}>
          {analysis.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}
