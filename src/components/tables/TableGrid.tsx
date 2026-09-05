import { useMemo, useState } from 'react';
import type { TableData } from '../../lib/rom/readTable';
import { clampAndQuantise } from '../../lib/rom/readTable';
import { heatColor } from '../../lib/log/palette';

export interface CellSuggestion {
  value: number;
  delta: number;
  confidence: number;
  reason: string;
  samples: number;
  knock: number;
}

export interface TableGridProps {
  table: TableData;
  /** User edits keyed "row,col". */
  edits: Record<string, number>;
  /** AI suggestions keyed "row,col". */
  suggestions?: Map<string, CellSuggestion>;
  showSuggestions?: boolean;
  onEdit?(row: number, col: number, value: number | null): void;
  /** Sample counts per cell, to shade cells the logs never visited. */
  coverage?: number[][];
}

export const cellKey = (row: number, col: number) => `${row},${col}`;

/** Value the ECU would see: the edit if there is one, otherwise the ROM value. */
export function effectiveValue(table: TableData, edits: Record<string, number>, r: number, c: number): number {
  const e = edits[cellKey(r, c)];
  return e === undefined ? table.values[r][c] : e;
}

/** The whole table as it currently stands, ready for export. */
export function currentGrid(
  table: TableData,
  edits: Record<string, number>,
  suggestions?: Map<string, CellSuggestion>,
): number[][] {
  return table.values.map((row, r) =>
    row.map((_, c) => {
      const s = suggestions?.get(cellKey(r, c));
      if (s) return s.value;
      return effectiveValue(table, edits, r, c);
    }),
  );
}

export function TableGrid({
  table, edits, suggestions, showSuggestions = false, onEdit, coverage,
}: TableGridProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());

  const display = useMemo(
    () => currentGrid(table, edits, showSuggestions ? suggestions : undefined),
    [table, edits, suggestions, showSuggestions],
  );

  const { lo, hi } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const row of display) {
      for (const v of row) {
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return { lo: min, hi: max };
  }, [display]);

  const span = hi - lo;

  const commit = (r: number, c: number) => {
    setEditing(null);
    if (!onEdit) return;
    const trimmed = draft.trim();
    if (trimmed === '') { onEdit(r, c, null); return; }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const quantised = clampAndQuantise(table.scaling, parsed);
    // Storing a value identical to the ROM's is the same as having no edit.
    onEdit(r, c, quantised === table.values[r][c] ? null : quantised);
  };

  return (
    <div className="grid-scroll">
      <table className="tune">
        <thead>
          <tr>
            <th>
              {table.y.name || ''}
              {table.x.name ? ` \\ ${table.x.name}` : ''}
            </th>
            {table.x.labels.slice(0, table.nx).map((label, c) => (
              <th key={c} title={`${table.x.name} ${label} ${table.x.units}`}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map((row, r) => (
            <tr key={r}>
              <th title={`${table.y.name} ${table.y.labels[r]} ${table.y.units}`}>
                {table.y.labels[r] ?? r}
              </th>
              {row.map((value, c) => {
                const key = cellKey(r, c);
                const suggestion = showSuggestions ? suggestions?.get(key) : undefined;
                const edited = edits[key] !== undefined;
                const samples = coverage?.[r]?.[c];
                const t = span > 0 ? (value - lo) / span : 0.5;
                const noData = samples !== undefined && samples === 0;

                const title = [
                  `${table.y.name} ${table.y.labels[r]} · ${table.x.name} ${table.x.labels[c]}`,
                  `ROM: ${table.values[r][c]}${table.units ? ` ${table.units}` : ''}`,
                  edited ? `Edited: ${edits[key]}` : null,
                  samples !== undefined ? `${samples} log samples` : null,
                  suggestion
                    ? `Suggested ${suggestion.value} (${suggestion.delta >= 0 ? '+' : ''}${suggestion.delta.toFixed(1)})\n` +
                      `${suggestion.samples} samples, ${suggestion.knock} knock, ` +
                      `confidence ${(suggestion.confidence * 100).toFixed(0)}%\n${suggestion.reason}`
                    : null,
                ].filter(Boolean).join('\n');

                return (
                  <td
                    key={c}
                    title={title}
                    className={[
                      selection.has(key) ? 'selected' : '',
                      edited ? 'edited' : '',
                      suggestion ? 'suggested' : '',
                    ].join(' ').trim()}
                    style={{
                      background: Number.isFinite(value) ? heatColor(t) : '#171b21',
                      opacity: noData ? 0.42 : 1,
                    }}
                    onClick={(e) => {
                      setSelection((prev) => {
                        const next = e.shiftKey ? new Set(prev) : new Set<string>();
                        if (next.has(key)) next.delete(key); else next.add(key);
                        return next;
                      });
                    }}
                    onDoubleClick={() => {
                      if (!onEdit) return;
                      setEditing(key);
                      setDraft(String(value));
                    }}
                  >
                    {editing === key ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(r, c)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(r, c);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                    ) : (
                      <span className={
                        suggestion ? (suggestion.delta > 0 ? 'delta-up' : suggestion.delta < 0 ? 'delta-down' : '') : ''
                      }>
                        {Number.isFinite(value) ? value.toFixed(table.decimals) : '—'}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
