import { useState } from 'react';
import type { TableData } from '../../lib/rom/readTable';
import { currentGrid } from './TableGrid';
import type { CellSuggestion } from './TableGrid';

export interface CopyOutProps {
  table: TableData;
  edits: Record<string, number>;
  suggestions?: Map<string, CellSuggestion>;
  showSuggestions?: boolean;
}

/**
 * Tab-separated export in the orientation EcuFlash displays.
 *
 * Paste target is EcuFlash's own table view: select the top-left cell there and
 * paste. This app deliberately never writes a .bin — a wrong checksum or a
 * misread scaling would turn into a bad flash, and a clipboard round-trip keeps
 * your existing tool in charge of what actually reaches the ECU.
 */
export function toTsv(
  table: TableData,
  edits: Record<string, number>,
  suggestions: Map<string, CellSuggestion> | undefined,
  opts: { includeAxes: boolean; useSuggestions: boolean },
): string {
  const grid = currentGrid(table, edits, opts.useSuggestions ? suggestions : undefined);
  const body = grid.map((row, r) => {
    const cells = row.map((v) => (Number.isFinite(v) ? v.toFixed(table.decimals) : ''));
    return opts.includeAxes ? [table.y.labels[r] ?? '', ...cells].join('\t') : cells.join('\t');
  });
  if (!opts.includeAxes) return body.join('\n');
  const header = ['', ...table.x.labels.slice(0, table.nx)].join('\t');
  return [header, ...body].join('\n');
}

export function CopyOut({ table, edits, suggestions, showSuggestions = false }: CopyOutProps) {
  const [includeAxes, setIncludeAxes] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const copy = async (useSuggestions: boolean) => {
    const text = toTsv(table, edits, suggestions, { includeAxes, useSuggestions });
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`Copied ${table.ny} × ${table.nx} cells`);
    } catch {
      // Clipboard access can be blocked; fall back to a selectable textarea.
      setStatus('Clipboard blocked — select the text below and copy manually');
      window.prompt('Copy this into EcuFlash:', text);
    }
    setTimeout(() => setStatus(null), 3000);
  };

  return (
    <div className="row">
      <button className="primary" onClick={() => void copy(false)}>
        Copy table
      </button>
      {suggestions && suggestions.size > 0 && (
        <button onClick={() => void copy(true)} disabled={!showSuggestions}>
          Copy with suggestions
        </button>
      )}
      <label className="row small muted" style={{ gap: 5 }}>
        <input
          type="checkbox"
          checked={includeAxes}
          onChange={(e) => setIncludeAxes(e.target.checked)}
        />
        include axis labels
      </label>
      {status && <span className="small muted">{status}</span>}
    </div>
  );
}
