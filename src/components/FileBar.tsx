import { useRef, useState } from 'react';
import { useProject } from '../state/project';

/** Load ROM, definition and log files. Everything is parsed locally. */
export function FileBar() {
  const project = useProject();
  const inputRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [over, setOver] = useState(false);

  const accept = async (files: FileList | File[] | null) => {
    if (!files) return;
    setErrors(await project.loadFiles(Array.from(files)));
  };

  /**
   * Open the picker restricted to one kind of file. The single "Upload files"
   * button accepts everything at once; these narrow it when you only want to
   * swap the ROM or add another log.
   */
  const pick = (accepts: string) => {
    const input = inputRef.current;
    if (!input) return;
    input.accept = accepts;
    input.click();
  };

  const nothingLoaded = !project.rom && !project.definition && project.logs.length === 0;

  return (
    <div className="panel">
      <h2>Files</h2>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void accept(e.dataTransfer.files); }}
      >
        <button
          className="primary"
          style={{ padding: '8px 18px', fontSize: 13 }}
          onClick={() => pick('.csv,.xml,.bin,.rom,.hex')}
        >
          Upload files
        </button>
        <div className="small" style={{ marginTop: 8 }}>
          or drag and drop them here
        </div>

        <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
          <button className="small" onClick={() => pick('.csv')}>Log .csv</button>
          <button className="small" onClick={() => pick('.xml')}>Definition .xml</button>
          <button className="small" onClick={() => pick('.bin,.rom,.hex')}>ROM .bin</button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".csv,.xml,.bin,.rom,.hex"
        style={{ display: 'none' }}
        onChange={(e) => { void accept(e.target.files); e.target.value = ''; }}
      />

      {nothingLoaded && (
        <div className="muted small" style={{ marginTop: 8, textAlign: 'center' }}>
          Files are read in this browser. Nothing is sent to a server.
        </div>
      )}

      {errors.length > 0 && (
        <div className="notice bad" style={{ marginTop: 10 }}>
          <strong>Could not load {errors.length} file(s)</strong>
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {(project.rom || project.definition) && (
        <div style={{ marginTop: 10 }}>
          {project.definition && (
            <div className="file-row">
              <span className="badge ok">XML</span>
              <span className="name" title={project.definition.name}>{project.definition.name}</span>
              <span className="muted small">{project.definition.definition.tables.length} tables</span>
            </div>
          )}
          {project.rom && (
            <div className="file-row">
              <span className="badge ok">ROM</span>
              <span className="name" title={project.rom.name}>{project.rom.name}</span>
              <span className="muted small">{(project.rom.bytes.length / 1024).toFixed(0)} KB</span>
            </div>
          )}
        </div>
      )}

      {project.identity && (
        <div className={`notice ${project.identity.matches ? 'good' : 'bad'}`} style={{ marginTop: 8 }}>
          {project.identity.message}
        </div>
      )}

      {project.logs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="group-title">Logs ({project.logs.length})</div>
          {project.logs.map(({ log }) => {
            const active = project.activeLogIds.includes(log.id);
            return (
              <div className="file-row" key={log.id}>
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() =>
                    project.setActiveLogIds(
                      active
                        ? project.activeLogIds.filter((id) => id !== log.id)
                        : [...project.activeLogIds, log.id],
                    )
                  }
                />
                <span className="name" title={log.name}>{log.name}</span>
                <span className="muted small">
                  {log.rowCount.toLocaleString()} rows · {log.duration.toFixed(0)}s
                </span>
                <button className="small" onClick={() => project.removeLog(log.id)} title="Remove">
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
