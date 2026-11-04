import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts because the app root is src/apps,
// while the tests live next to the code in src/shared.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
