import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local development: the browser talks to Vite (5173) and /api is forwarded to the backend (5000),
// so VITE_API_URL can stay empty. In production (Vercel) set VITE_API_URL to your Render URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:5000', changeOrigin: true } },
  },
});