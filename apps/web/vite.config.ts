/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Same origin as the API, so its cookies work and no CORS is needed (production: Caddy, T4.3).
  // `vite preview` uses it too; the browser test points it at its own API (API_URL).
  server: { proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
