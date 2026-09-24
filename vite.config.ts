import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Porte dedicate per non entrare in conflitto con altri progetti Vite (5173/4173).
  // Se la porta è occupata, Vite passa automaticamente alla successiva libera.
  server: { port: 3210, open: true },
  preview: { port: 3211, open: true },
});
