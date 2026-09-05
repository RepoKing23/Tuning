import type { ChannelHealth } from '../../lib/log/channelHealth';
import type { ChannelGroup, LogFile } from '../../lib/log/types';
import { colorFor } from '../../lib/log/palette';

const GROUP_ORDER: ChannelGroup[] = ['Engine', 'Airflow', 'Fuel', 'Spark', 'Temps', 'Trans', 'Other'];

export interface ChannelPanelProps {
  log: LogFile;
  health: Map<string, ChannelHealth>;
  visible: string[];
  focused: string | null;
  cursorRow: number | null;
  onToggle(name: string): void;
  onFocus(name: string): void;
  onSetVisible(names: string[]): void;
}

export function ChannelPanel({
  log, health, visible, focused, cursorRow, onToggle, onFocus, onSetVisible,
}: ChannelPanelProps) {
  const shown = new Set(visible);

  const valueAt = (name: string): string => {
    const ch = log.byName.get(name);
    if (!ch) return '';
    if (cursorRow === null || cursorRow < 0 || cursorRow >= ch.values.length) {
      return Number.isFinite(ch.mean) ? `x̄ ${ch.mean.toFixed(1)}` : '—';
    }
    const v = ch.values[cursorRow];
    return Number.isNaN(v) ? '—' : v.toFixed(2).replace(/\.00$/, '');
  };

  const healthyNames = log.channels
    .filter((c) => health.get(c.name)?.status === 'ok')
    .map((c) => c.name);

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="small" onClick={() => onSetVisible([])}>None</button>
        <button className="small" onClick={() => onSetVisible(healthyNames)}>
          All healthy
        </button>
        <span className="muted small">{visible.length} shown</span>
      </div>

      {GROUP_ORDER.map((group) => {
        const channels = log.channels.filter((c) => c.group === group);
        if (channels.length === 0) return null;
        return (
          <div key={group}>
            <div className="group-title">{group}</div>
            {channels.map((ch) => {
              const h = health.get(ch.name);
              const status = h?.status ?? 'ok';
              return (
                <div
                  key={ch.name}
                  className={`channel${focused === ch.name ? ' focused' : ''}`}
                  title={
                    h && h.reasons.length
                      ? `${ch.name}\n${h.reasons.join('\n')}`
                      : `${ch.name}${ch.unit ? ` (${ch.unit})` : ''}\n` +
                        `min ${ch.min} · max ${ch.max} · mean ${ch.mean.toFixed(2)}`
                  }
                  onClick={() => onFocus(ch.name)}
                >
                  <input
                    type="checkbox"
                    checked={shown.has(ch.name)}
                    onChange={() => onToggle(ch.name)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="swatch" style={{ background: colorFor(ch.name) }} />
                  <span className="name">{ch.name}</span>
                  {status !== 'ok' && <span className={`badge ${status}`}>{status}</span>}
                  <span className="value">{valueAt(ch.name)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
