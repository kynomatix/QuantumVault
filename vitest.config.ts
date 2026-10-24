import { configDefaults, defineConfig } from 'vitest/config';
import { realDatabaseSuites } from './tests/helpers/real-database-suites';
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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...realDatabaseSuites],
        },
      },
      {
        extends: true,
        test: {
          name: 'database',
          include: realDatabaseSuites,
          // One qvtest database: DDL, catalogs, fixed keys and pool slots are shared.
          // Preserve deliberate connection concurrency inside each database suite.
          fileParallelism: false,
        },
      },
    ],
    environment: 'node',
    env: {
      PYTH_HERMES_MODE: process.env.PYTH_HERMES_MODE ?? 'live',
    },
  },
});
