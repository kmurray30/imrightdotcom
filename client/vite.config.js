import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev-only: proxy API calls and legacy static asset paths (article images,
// the shared Pixabay cache, etc.) to the Express server so `npm run dev`
// here doesn't need its own copy of any of that. Prod serves client/dist
// directly from Express — see serve-site.js — so this block is inert there.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3758',
      '/tabloid_generator': 'http://127.0.0.1:3758',
      '/config': 'http://127.0.0.1:3758',
    },
  },
});
