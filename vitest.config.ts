import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// Separate from vite.config.ts because the app root is src/apps,
// while tests live next to the code all over src/.
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
