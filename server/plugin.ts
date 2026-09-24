import type { Plugin } from 'vite';
import { handleApi } from './api.ts';

/** Monta l'API locale (/api) sia in `vite` (sviluppo) sia in `vite preview`. */
export function finanzaApi(): Plugin {
  return {
    name: 'finanza-api',
    configureServer(server) {
      server.middlewares.use('/api', handleApi);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api', handleApi);
    },
  };
}
