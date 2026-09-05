import { createContext, useContext } from 'react';
import type { LogFile } from '../lib/log/types';
import type { ChannelHealth } from '../lib/log/channelHealth';
import type { RomDefinition } from '../lib/rom/parseDefinitionXml';
import type { RomIdentity } from '../lib/rom/romIdentify';

export interface LoadedLog {
  log: LogFile;
  health: Map<string, ChannelHealth>;
  /** Raw text kept so the log survives a page reload. */
  source: string;
}

export interface LoadedRom {
  name: string;
  bytes: Uint8Array;
}

export interface LoadedDefinition {
  name: string;
  definition: RomDefinition;
  source: string;
}

export interface ProjectState {
  logs: LoadedLog[];
  activeLogIds: string[];
  rom: LoadedRom | null;
  definition: LoadedDefinition | null;
  identity: RomIdentity | null;
  /** User edits to table cells, keyed by table id then "row,col". */
  edits: Record<string, Record<string, number>>;
}

export const emptyProject: ProjectState = {
  logs: [],
  activeLogIds: [],
  rom: null,
  definition: null,
  identity: null,
  edits: {},
};

export interface ProjectApi extends ProjectState {
  loadFiles(files: File[]): Promise<string[]>;
  removeLog(id: string): void;
  setActiveLogIds(ids: string[]): void;
  setEdit(tableId: string, row: number, col: number, value: number | null): void;
  clearEdits(tableId: string): void;
  clearAll(): void;
}

export const ProjectContext = createContext<ProjectApi | null>(null);

export function useProject(): ProjectApi {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside <ProjectProvider>');
  return ctx;
}

/** The logs currently selected for plotting and analysis. */
export function activeLogs(state: ProjectState): LoadedLog[] {
  return state.logs.filter((l) => state.activeLogIds.includes(l.log.id));
}
