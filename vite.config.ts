import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import vercelApiPlugin from './dev/vercelApiPlugin.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), vercelApiPlugin()],
  test: {
    // e2e/ holds Playwright specs, run via `npx playwright test` — not vitest.
    // .claude/ holds session worktrees whose copies of the repo would
    // otherwise be scanned (and their e2e specs crash vitest).
    exclude: [...configDefaults.exclude, 'e2e/**', '.claude/**'],
  },
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('framer-motion') || id.includes('react-dom') || id.includes('react/')) return 'vendor';
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
        },
      },
    },
  },
})
