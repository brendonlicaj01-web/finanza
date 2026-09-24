import { useEffect, useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Positions } from './pages/Positions';
import { Transactions } from './pages/Transactions';
import { Assets } from './pages/Assets';
import { Accounts } from './pages/Accounts';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Icon } from './components/ui';

export type Page = 'panoramica' | 'posizioni' | 'transazioni' | 'strumenti' | 'conti' | 'report' | 'impostazioni';

const NAV: { page: Page; label: string; icon: string }[] = [
  { page: 'panoramica', label: 'Panoramica', icon: 'dashboard' },
  { page: 'posizioni', label: 'Posizioni', icon: 'positions' },
  { page: 'transazioni', label: 'Transazioni', icon: 'transactions' },
  { page: 'strumenti', label: 'Strumenti', icon: 'assets' },
  { page: 'conti', label: 'Conti', icon: 'accounts' },
  { page: 'report', label: 'Report', icon: 'reports' },
  { page: 'impostazioni', label: 'Impostazioni', icon: 'settings' },
];

function pageFromHash(): Page {
  const h = location.hash.slice(1) as Page;
  return NAV.some((n) => n.page === h) ? h : 'panoramica';
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (p: Page) => {
    location.hash = p;
    setPage(p);
    window.scrollTo(0, 0);
  };

  const nav = NAV.map((n) => (
    <button
      key={n.page}
      className="nav-item"
      aria-current={page === n.page ? 'page' : undefined}
      onClick={() => go(n.page)}
    >
      <Icon name={n.icon} />
      {n.label}
    </button>
  ));

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Navigazione principale">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 17l6-6 4 4 7-8" />
            </svg>
          </span>
          Finanza
        </div>
        {nav}
      </nav>
      <main className="main">
        {page === 'panoramica' && <Dashboard go={go} />}
        {page === 'posizioni' && <Positions />}
        {page === 'transazioni' && <Transactions />}
        {page === 'strumenti' && <Assets />}
        {page === 'conti' && <Accounts />}
        {page === 'report' && <Reports />}
        {page === 'impostazioni' && <Settings />}
      </main>
      <nav className="mobile-nav" aria-label="Navigazione">
        {nav}
      </nav>
    </div>
  );
}
