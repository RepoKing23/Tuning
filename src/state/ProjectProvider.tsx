import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { parseEvoScanCsv } from '../lib/log/parseEvoScanCsv';
import { assessChannels } from '../lib/log/channelHealth';
import { parseDefinitionXml } from '../lib/rom/parseDefinitionXml';
import { identifyRom } from '../lib/rom/romIdentify';
import { idbGet, idbSet } from '../lib/storage/idb';
import { ProjectContext, emptyProject } from './project';
import type { LoadedDefinition, LoadedLog, LoadedRom, ProjectApi, ProjectState } from './project';

interface PersistedLog { name: string; source: string }
interface Persisted {
  logs: PersistedLog[];
  rom: { name: string; bytes: ArrayBuffer } | null;
  definition: { name: string; source: string } | null;
  edits: ProjectState['edits'];
}

const KEY = 'project';

function classify(name: string): 'log' | 'rom' | 'definition' | 'unknown' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'log';
  if (lower.endsWith('.xml')) return 'definition';
  if (lower.endsWith('.bin') || lower.endsWith('.hex') || lower.endsWith('.rom')) return 'rom';
  return 'unknown';
}

function makeLog(name: string, source: string, id?: string): LoadedLog {
  const log = parseEvoScanCsv(source, name, id);
  return { log, health: assessChannels(log), source };
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProjectState>(emptyProject);
  const restored = useRef(false);

  // Restore whatever was loaded last time.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await idbGet<Persisted>(KEY);
      if (cancelled || !saved) { restored.current = true; return; }
      const next: ProjectState = { ...emptyProject, edits: saved.edits ?? {} };
      try {
        next.logs = (saved.logs ?? []).map((l) => makeLog(l.name, l.source, l.name));
        next.activeLogIds = next.logs.map((l) => l.log.id);
      } catch { /* a corrupt cache should not block startup */ }
      if (saved.definition) {
        try {
          next.definition = {
            name: saved.definition.name,
            source: saved.definition.source,
            definition: parseDefinitionXml(saved.definition.source),
          };
        } catch { /* ignore */ }
      }
      if (saved.rom) {
        next.rom = { name: saved.rom.name, bytes: new Uint8Array(saved.rom.bytes) };
      }
      if (next.rom && next.definition) {
        next.identity = identifyRom(next.rom.bytes, next.definition.definition);
      }
      if (!cancelled) setState(next);
      restored.current = true;
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist after every change, once the initial restore has settled.
  useEffect(() => {
    if (!restored.current) return;
    const payload: Persisted = {
      logs: state.logs.map((l) => ({ name: l.log.name, source: l.source })),
      rom: state.rom
        ? { name: state.rom.name, bytes: state.rom.bytes.slice().buffer }
        : null,
      definition: state.definition
        ? { name: state.definition.name, source: state.definition.source }
        : null,
      edits: state.edits,
    };
    void idbSet(KEY, payload);
  }, [state]);

  const loadFiles = useCallback(async (files: File[]): Promise<string[]> => {
    const errors: string[] = [];
    let nextLogs: LoadedLog[] = [];
    let nextRom: LoadedRom | null = null;
    let nextDef: LoadedDefinition | null = null;

    for (const file of files) {
      const kind = classify(file.name);
      try {
        if (kind === 'log') {
          nextLogs.push(makeLog(file.name, await file.text(), file.name));
        } else if (kind === 'definition') {
          const source = await file.text();
          nextDef = { name: file.name, source, definition: parseDefinitionXml(source) };
        } else if (kind === 'rom') {
          nextRom = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
        } else {
          errors.push(`${file.name}: unrecognised file type (expected .csv, .xml or .bin)`);
        }
      } catch (err) {
        errors.push(`${file.name}: ${(err as Error).message}`);
      }
    }

    setState((prev) => {
      // Reloading a log with the same name replaces it rather than duplicating.
      const keep = prev.logs.filter((l) => !nextLogs.some((n) => n.log.id === l.log.id));
      const logs = [...keep, ...nextLogs];
      const rom = nextRom ?? prev.rom;
      const definition = nextDef ?? prev.definition;
      return {
        ...prev,
        logs,
        activeLogIds: nextLogs.length
          ? [...prev.activeLogIds.filter((id) => logs.some((l) => l.log.id === id)),
             ...nextLogs.map((l) => l.log.id)]
          : prev.activeLogIds,
        rom,
        definition,
        identity: rom && definition ? identifyRom(rom.bytes, definition.definition) : null,
      };
    });

    nextLogs = [];
    return errors;
  }, []);

  const removeLog = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      logs: prev.logs.filter((l) => l.log.id !== id),
      activeLogIds: prev.activeLogIds.filter((a) => a !== id),
    }));
  }, []);

  const setActiveLogIds = useCallback((ids: string[]) => {
    setState((prev) => ({ ...prev, activeLogIds: ids }));
  }, []);

  const setEdit = useCallback((tableId: string, row: number, col: number, value: number | null) => {
    setState((prev) => {
      const table = { ...(prev.edits[tableId] ?? {}) };
      const key = `${row},${col}`;
      if (value === null) delete table[key];
      else table[key] = value;
      const edits = { ...prev.edits };
      if (Object.keys(table).length) edits[tableId] = table;
      else delete edits[tableId];
      return { ...prev, edits };
    });
  }, []);

  const clearEdits = useCallback((tableId: string) => {
    setState((prev) => {
      const edits = { ...prev.edits };
      delete edits[tableId];
      return { ...prev, edits };
    });
  }, []);

  const clearAll = useCallback(() => setState(emptyProject), []);

  const api = useMemo<ProjectApi>(
    () => ({ ...state, loadFiles, removeLog, setActiveLogIds, setEdit, clearEdits, clearAll }),
    [state, loadFiles, removeLog, setActiveLogIds, setEdit, clearEdits, clearAll],
  );

  return <ProjectContext.Provider value={api}>{children}</ProjectContext.Provider>;
}
