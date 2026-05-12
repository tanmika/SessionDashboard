import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const dashboardPort = process.env.SESSION_DASHBOARD_PORT || '38473'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${dashboardPort}`,
      '/ws': {
        target: `ws://localhost:${dashboardPort}`,
        ws: true,
      },
    },
  },
})
