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
          // Keep the normal worker group so database work overlaps parallel units.
          // setupFiles serializes database files before their imports can issue SQL.
          setupFiles: ['./tests/helpers/serial-database-suite.ts'],
          sequence: { hooks: 'stack' },
        },
      },
    ],
    environment: 'node',
    env: {
      PYTH_HERMES_MODE: process.env.PYTH_HERMES_MODE ?? 'live',
    },
  },
});
