import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('./src/apps'),
  publicDir: r('./public'),
  plugins: [react()],
  resolve: {
    alias: { '@shared': r('./src/shared') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: r('./src/apps/index.html'),
        results: r('./src/apps/results/index.html'),
        pollWorker: r('./src/apps/poll-worker/index.html'),
        auditor: r('./src/apps/auditor/index.html'),
        operations: r('./src/apps/operations/index.html'),
      },
    },
  },
})
