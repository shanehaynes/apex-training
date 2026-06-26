import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
