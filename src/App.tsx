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
  // A table the AFR diagnosis asked to open, handed to TablesPage once.
  const [pendingTable, setPendingTable] = useState<string | null>(null);
  // On a phone the sidebar is a drawer; on desktop this class does nothing.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <ProjectProvider>
      <div className={`app${drawerOpen ? ' drawer-open' : ''}`}>
        <header className="topbar">
          <h1>
            4B11 Tuner <span>· EcuFlash + EvoScan workbench</span>
          </h1>
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={() => { setTab(t.id); closeDrawer(); }}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <span className="muted small">Everything is parsed in this browser — nothing is uploaded</span>
          <button className="sidebar-toggle" onClick={() => setDrawerOpen((o) => !o)}>
            {drawerOpen ? 'Close' : 'Files & options'}
          </button>
        </header>

        <div className="scrim" onClick={closeDrawer} />

        {tab === 'viewer' && <ViewerPage />}
        {tab === 'tables' && (
          <TablesPage pendingTable={pendingTable} onConsumePending={() => setPendingTable(null)} />
        )}
        {tab === 'tune' && (
          <TunePage
            onOpenTable={(name) => { setPendingTable(name); setTab('tables'); }}
          />
        )}
      </div>
    </ProjectProvider>
  );
}
