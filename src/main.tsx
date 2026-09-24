import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from './store';
import { SyncProvider } from './sync';
import { applyTheme } from './theme';
import './styles.css';

applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <SyncProvider>
        <App />
      </SyncProvider>
    </StoreProvider>
  </StrictMode>,
);
