import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.spec.{ts,tsx}'],
    // The jsdom suites here mount React and poll for DOM state, so their wall
    // clock competes with the sibling package `pnpm test` runs alongside them
    // (--workspace-concurrency=2). At the 5s default, a contended run expires a
    // wait that would settle in ~1.5s on an idle machine — a false red, not a
    // regression. Budget for the contention instead of the idle case.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
})
