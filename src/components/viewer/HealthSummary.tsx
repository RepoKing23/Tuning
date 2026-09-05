import { useState } from 'react';
import type { ChannelHealth } from '../../lib/log/channelHealth';
import { fuelFeedback } from '../../lib/log/channelHealth';
import type { LogFile } from '../../lib/log/types';

/**
 * What this log can and cannot be used for.
 *
 * Shown before any analysis because a broken channel does not announce itself —
 * a coolant sensor stuck at -13 C or a wideband pinned at 99.9 produces graphs
 * that look perfectly reasonable and recommendations that are worthless.
 */
export function HealthSummary({ log, health }: { log: LogFile; health: Map<string, ChannelHealth> }) {
  const [open, setOpen] = useState(false);

  const problems = [...health.values()].filter((h) => h.status !== 'ok');
  // A channel your EvoScan config simply does not request is not a fault — it
  // is a column of blanks. Counting those alongside genuinely broken sensors
  // turns the headline into noise.
  const notLogged = problems.filter((h) => h.nullFraction === 1);
  const broken = problems.filter((h) => h.nullFraction < 1);
  const feedback = fuelFeedback(log, health);

  const feedbackLine =
    feedback.source === 'none'
      ? `MAF scaling is unavailable for this log: ${feedback.reason}`
      : `MAF scaling will use ${feedback.reason}.`;

  if (broken.length === 0 && feedback.source !== 'none') {
    return (
      <div className="notice good">
        <strong>Every channel you are logging looks healthy</strong>
        {feedbackLine}
        {notLogged.length > 0 && (
          <div className="muted small" style={{ marginTop: 4 }}>
            {notLogged.length} further channel{notLogged.length === 1 ? '' : 's'} in the CSV header{' '}
            {notLogged.length === 1 ? 'is' : 'are'} not being requested at all.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`notice ${feedback.source === 'none' ? 'warn' : 'info'}`}>
      <strong>
        {broken.length} logged channel{broken.length === 1 ? '' : 's'}{' '}
        {broken.length === 1 ? 'is' : 'are'} not trustworthy
        {notLogged.length > 0 && `, and ${notLogged.length} more are not being logged`}
      </strong>
      {feedbackLine}
      <div style={{ marginTop: 6 }}>
        <button className="small" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide details' : `Show details (${problems.length})`}
        </button>
      </div>
      {open && (
        <ul>
          {[...broken, ...notLogged].map((h) => (
            <li key={h.name}>
              <span className={`badge ${h.status}`}>{h.status}</span>{' '}
              <strong style={{ display: 'inline' }}>{h.name}</strong> — {h.reasons.join('; ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
