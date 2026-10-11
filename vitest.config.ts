import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // Match the automatic JSX runtime used by the application's Vite React plugin.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'client', 'src'),
      '@shared': path.resolve(import.meta.dirname, 'shared'),
      '@assets': path.resolve(import.meta.dirname, 'attached_assets'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: {
      PYTH_HERMES_MODE: process.env.PYTH_HERMES_MODE ?? 'live',
    },
  },
});
