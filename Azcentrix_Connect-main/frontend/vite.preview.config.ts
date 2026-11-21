import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const projectRoot = process.cwd()

export default defineConfig({
  root: projectRoot,
  cacheDir: path.resolve(projectRoot, 'node_modules/.vite-preview'),
  plugins: [react()],
  build: {
    outDir: path.resolve(projectRoot, 'dist-preview'),
    rollupOptions: {
      input: path.resolve(projectRoot, 'preview.html'),
    },
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@': path.resolve(projectRoot, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 4321,
  },
  preview: {
    host: '0.0.0.0',
    port: 4321,
  },
})
