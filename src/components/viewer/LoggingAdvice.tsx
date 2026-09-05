import { useState } from 'react';
import type { Advice } from '../../lib/log/loggingAdvice';

const SEVERITY_LABEL: Record<Advice['severity'], string> = {
  blocking: 'blocking',
  important: 'important',
  minor: 'worth doing',
};

const SEVERITY_CLASS: Record<Advice['severity'], string> = {
  blocking: 'dead',
  important: 'suspect',
  minor: 'ok',
};

/**
 * What to change about the logging setup before tuning further.
 *
 * Deliberately phrased as actions with a stated payoff, rather than a list of
 * faults: a tuner staring at eight red badges cannot tell which one is worth
 * their evening.
 */
export function LoggingAdvice({ advice }: { advice: Advice[] }) {
  const [open, setOpen] = useState(false);

  if (advice.length === 0) {
    return (
      <div className="notice good">
        <strong>Nothing to improve about this logging setup</strong>
        Sample rate, channel health and map coverage all look sufficient.
      </div>
    );
  }

  const blocking = advice.filter((a) => a.severity === 'blocking').length;
  const important = advice.filter((a) => a.severity === 'important').length;

  return (
    <div className={`notice ${blocking ? 'bad' : important ? 'warn' : 'info'}`}>
      <strong>
        {advice.length} thing{advice.length === 1 ? '' : 's'} would make these logs more useful
      </strong>
      {blocking > 0
        ? `${blocking} of them block analysis outright.`
        : important > 0
          ? `${important} materially limit what can be tuned.`
          : 'All minor — the logs are usable as they are.'}
      <div style={{ marginTop: 6 }}>
        <button className="small" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : `Show what to change (${advice.length})`}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {advice.map((a) => (
            <div
              key={a.id}
              className="panel"
              style={{ margin: '0 0 8px', background: 'var(--panel-2)' }}
            >
              <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                <span className={`badge ${SEVERITY_CLASS[a.severity]}`}>
                  {SEVERITY_LABEL[a.severity]}
                </span>
                <strong style={{ display: 'inline' }}>{a.title}</strong>
              </div>
              <div className="small" style={{ marginTop: 4 }}>{a.detail}</div>
              <div className="small muted" style={{ marginTop: 4 }}>
                <strong style={{ display: 'inline' }}>Unlocks:</strong> {a.unlocks}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
