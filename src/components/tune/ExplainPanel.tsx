import { useState } from 'react';
import type { TableData } from '../../lib/rom/readTable';
import type { Recommendation } from '../../lib/tune/types';
import type { ProfileId } from '../../lib/tune/profiles';
import { explainRecommendation, getApiKey, setApiKey } from '../../lib/ai/claude';

export interface ExplainPanelProps {
  table: TableData;
  recommendation: Recommendation;
  profile?: ProfileId;
  healthNotes: string[];
}

/**
 * The optional Claude layer, off by default.
 *
 * The recommendations above are already complete without this; it explains them
 * and answers follow-up questions.
 */
export function ExplainPanel({ table, recommendation, profile, healthNotes }: ExplainPanelProps) {
  const [enabled, setEnabled] = useState(() => !!getApiKey());
  const [key, setKey] = useState(getApiKey);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await explainRecommendation({ table, recommendation, profile, healthNotes, question }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Explain with Claude (optional)</h2>

      <label className="row small" style={{ gap: 6, marginBottom: 8 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Use an Anthropic API key to explain these suggestions in plain English
      </label>

      {!enabled ? (
        <div className="muted small">
          Off. Every number above is computed locally and does not need this.
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              type="password"
              placeholder="sk-ant-…"
              value={key}
              onChange={(e) => { setKey(e.target.value); setApiKey(e.target.value); }}
              style={{ flex: 1, minWidth: 220 }}
            />
          </div>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Stored in this browser only and sent to Anthropic alone. Your ROM is never
            transmitted — only the computed summary and the changed cells.
          </div>

          <div className="row" style={{ marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Optional question, e.g. why did the 2500 rpm cells get pulled?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              style={{ flex: 1, minWidth: 240 }}
            />
            <button
              className="primary"
              onClick={() => void ask()}
              disabled={busy || !key || recommendation.status === 'blocked'}
            >
              {busy ? 'Asking…' : question.trim() ? 'Ask' : 'Explain'}
            </button>
          </div>

          {recommendation.status === 'blocked' && (
            <div className="muted small">
              Nothing to explain while the analysis is blocked — fix the logging first.
            </div>
          )}
          {error && <div className="notice bad">{error}</div>}
          {answer && (
            <div className="notice info" style={{ whiteSpace: 'pre-wrap' }}>{answer}</div>
          )}
        </>
      )}
    </div>
  );
}
