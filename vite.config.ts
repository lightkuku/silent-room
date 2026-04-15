import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'https://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
  optimizeDeps: {
    exclude: ['iink-ts', 'iink-js'],
    include: ['lucide-react'],
  },
});
