import { configDefaults, defineConfig } from 'vitest/config';
import { isolatedDatabaseSuites, realDatabaseSuites, sharedDatabaseSuites } from './tests/helpers/real-database-suites';
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
          name: 'database-shared',
          include: sharedDatabaseSuites,
          // Public DDL and fixed keys must finish before private-schema fixtures run.
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'database-isolated',
          include: isolatedDatabaseSuites,
          // Bound aggregate pools while preserving each suite's connection races.
          maxWorkers: 4,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    environment: 'node',
    env: {
      PYTH_HERMES_MODE: process.env.PYTH_HERMES_MODE ?? 'live',
    },
  },
});
