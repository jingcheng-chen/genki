import { defineConfig } from 'vitest/config'

/**
 * Vitest config for Phase 7 memory tests.
 *
 * - `jsdom` environment gives us `window` for the dev-hook probe in
 *   `repo.ts`. Pure math tests don't need it but jsdom is cheap.
 * - `fake-indexeddb/auto` installs a polyfill into `globalThis` so
 *   `idb-keyval` (and therefore `repo.ts`) can run without a browser.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
      'server/**/__tests__/**/*.test.ts',
      'server/**/*.test.ts',
    ],
    setupFiles: ['src/memory/__tests__/setup.ts'],
  },
})
