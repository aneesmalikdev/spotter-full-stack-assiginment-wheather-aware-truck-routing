import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ command }) => ({
  // Django serves the built files from /static/ (backend/config/settings.py: STATICFILES_DIRS).
  base: command === 'build' ? '/static/' : '/',
  plugins: [react()],
  build: {
    // MapLibre gets its own chunk: it is most of the code and changes far less often than the app.
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ }] } },
    },
    chunkSizeWarningLimit: 1200, // kB; MapLibre alone is about 1 MB minified
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8001' },
  },
  test: {
    environment: 'jsdom',
    env: { TZ: 'America/Chicago' }, // local-time tests run in US Central time, with its DST change
    setupFiles: ['src/test/setup.ts'],
  },
}))
