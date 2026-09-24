import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { finanzaApi } from './server/plugin.ts';

export default defineConfig({
  plugins: [react(), finanzaApi()],
  base: './',
  // Porte dedicate per non entrare in conflitto con altri progetti Vite (5173/4173).
  // Se la porta è occupata, Vite passa automaticamente alla successiva libera.
  // host "localhost": il server locale (con le chiavi API) non è raggiungibile da altri dispositivi.
  server: { port: 3210, open: true, host: 'localhost' },
  preview: { port: 3211, open: true, host: 'localhost' },
});
