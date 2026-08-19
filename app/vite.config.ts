import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served from https://retail-hedging.github.io/windfall/app/
export default defineConfig({
  plugins: [react()],
  base: '/windfall/app/',
  build: { outDir: 'dist', emptyOutDir: true }
})
