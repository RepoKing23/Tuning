import { useState } from 'react';
import { ProjectProvider } from './state/ProjectProvider';
import { ViewerPage } from './pages/ViewerPage';
import { TablesPage } from './pages/TablesPage';
import { TunePage } from './pages/TunePage';

type Tab = 'viewer' | 'tables' | 'tune';

const TABS: { id: Tab; label: string }[] = [
  { id: 'viewer', label: 'Log Viewer' },
  { id: 'tables', label: 'ROM Tables' },
  { id: 'tune', label: 'AI Tuning' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('viewer');

  return (
    <ProjectProvider>
      <div className="app">
        <header className="topbar">
          <h1>
            4B11 Tuner <span>· EcuFlash + EvoScan workbench</span>
          </h1>
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <span className="muted small">Everything is parsed in this browser — nothing is uploaded</span>
        </header>

        {tab === 'viewer' && <ViewerPage />}
        {tab === 'tables' && <TablesPage />}
        {tab === 'tune' && <TunePage />}
      </div>
    </ProjectProvider>
  );
}
