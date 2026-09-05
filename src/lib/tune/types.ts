import type { CellSuggestion } from '../../components/tables/TableGrid';

export type { CellSuggestion };

export interface Recommendation {
  /** `blocked` means the inputs cannot support an answer at all. */
  status: 'ok' | 'blocked';
  /** One-line explanation shown at the top of the tuning panel. */
  message: string;
  /** Keyed "row,col", matching the table grid. */
  suggestions: Map<string, CellSuggestion>;
  /** Longer-form observations worth reading before applying anything. */
  notes: string[];
  /** Cells that had data but were deliberately left alone, with the reason. */
  skipped: number;
  /** Cells with too little data to judge. */
  starved: number;
}

export const blocked = (message: string, notes: string[] = []): Recommendation => ({
  status: 'blocked',
  message,
  suggestions: new Map(),
  notes,
  skipped: 0,
  starved: 0,
});
