import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Proxy API + MCP + realtime (Socket.IO, ws upgrade) endpoints to the
    // Fastify server during development.
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      // The MCP outlet paths are `/mcp` and `/mcp/sse*`, but the string key
      // prefix-matches — it would also swallow the app's own `/mcp-servers`
      // page route. `bypass: false` lets those requests fall through to the SPA.
      '/mcp': {
        target: 'http://127.0.0.1:8080',
        // Serve the SPA shell for the app's own /mcp-servers route instead of
        // proxying it to the Fastify MCP outlet.
        bypass: (req) => (req.url?.startsWith('/mcp-servers') ? '/index.html' : undefined),
      },
      '/socket.io': { target: 'http://127.0.0.1:8080', ws: true },
    },
  },
});
