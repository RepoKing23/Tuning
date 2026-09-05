import type { AfrAnalysis } from '../../lib/tune/afr';

export interface AfrDiagnosisProps {
  analysis: AfrAnalysis;
  /** Jump to a table in the ROM Tables tab. */
  onOpenTable(name: string): void;
}

function pct(v: number): string {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
}

/**
 * The "which table do I fix" answer.
 *
 * The ranking matters more than the numbers: a tuner who knows the error is a
 * flat offset will go and check injectors, where one who only sees a correction
 * grid will bend a map around it and bury the fault.
 */
export function AfrDiagnosis({ analysis, onOpenTable }: AfrDiagnosisProps) {
  if (analysis.status === 'blocked') {
    return (
      <div className="notice warn">
        <strong>Cannot diagnose fuelling</strong>
        {analysis.message}
        {analysis.notes.length > 0 && (
          <ul>{analysis.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        )}
      </div>
    );
  }

  const lean = analysis.openLoopMedianPct >= 0;

  return (
    <>
      <div className="panel">
        <h2>Fuelling against your target</h2>

        <div className="split" style={{ gap: 10, marginBottom: 12 }}>
          <div className="panel" style={{ margin: 0, background: 'var(--panel-2)' }}>
            <div className="muted small">Open loop — commanded enrichment</div>
            <div
              style={{
                fontSize: 26, fontWeight: 700, fontFamily: 'var(--mono)',
                color: Math.abs(analysis.openLoopMedianPct) > 3 ? 'var(--warn)' : 'var(--ok)',
              }}
            >
              {pct(analysis.openLoopMedianPct)}
            </div>
            <div className="muted small">
              {lean ? 'lean of' : 'rich of'} target · {analysis.openLoopSamples.toLocaleString()} samples
            </div>
            <div className="small" style={{ marginTop: 6 }}>
              This is the number that means something.
            </div>
          </div>

          <div className="panel" style={{ margin: 0, background: 'var(--panel-2)' }}>
            <div className="muted small">Closed loop — O2 feedback active</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
              {pct(analysis.closedLoopMedianPct)}
            </div>
            <div className="muted small">
              {analysis.closedLoopSamples.toLocaleString()} samples
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>
              Near zero by construction — the ECU corrects to target here whatever the
              calibration says. Not evidence.
            </div>
          </div>
        </div>

        <div className="group-title">What is causing it</div>
        {analysis.causes.length === 0 ? (
          <div className="muted small">
            No cause large enough to name. Fuelling is tracking your target.
          </div>
        ) : (
          analysis.causes.map((cause, i) => (
            <div
              key={cause.id}
              className="panel"
              style={{ margin: '0 0 8px', background: 'var(--panel-2)' }}
            >
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>
                    {i === 0 && <span className="badge dead" style={{ marginRight: 6 }}>largest</span>}
                    {cause.label}
                  </strong>
                  <span className="mono muted" style={{ marginLeft: 8 }}>
                    ≈{cause.magnitudePct.toFixed(1)}%
                  </span>
                </div>
                {cause.table ? (
                  <button className="primary small" onClick={() => onOpenTable(cause.table!)}>
                    Open {cause.table}
                  </button>
                ) : (
                  <span className="badge suspect">no table</span>
                )}
              </div>
              <div className="small muted" style={{ marginTop: 5 }}>{cause.explanation}</div>
            </div>
          ))
        )}

        {analysis.notes.length > 0 && (
          <ul className="muted small" style={{ marginTop: 10, paddingLeft: 18 }}>
            {analysis.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </div>
    </>
  );
}
