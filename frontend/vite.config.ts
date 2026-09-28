/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Only VITE_* variables from frontend/.env are exposed to the browser. Never put secrets there.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Only crawl the app's entry; stray native build folders contain HTML too.
    entries: ['index.html'],
  },
  build: {
    // The LiveKit video SDK is one ~690 kB chunk that only loads on video call screens.
    chunkSizeWarningLimit: 750,
  },
  preview: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '4173'),
  },
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '5173'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
