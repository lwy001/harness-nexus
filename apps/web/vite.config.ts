import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API + MCP endpoints to the Fastify server during development.
    proxy: {
      '/api': 'http://127.0.0.1:7477',
      '/mcp': 'http://127.0.0.1:7477',
    },
  },
});
