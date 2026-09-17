import { defineConfig } from 'vite';

const SERVER_PORT = process.env.PORT ?? '8080';

/**
 * Sub-path the client is served from. GitHub Pages project sites live under
 * "/<repo>/", so build those with VITE_BASE=/<repo>/. Defaults to the root.
 */
const BASE = process.env.VITE_BASE ?? '/';

export default defineConfig({
  root: 'src/client',
  base: BASE,
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/socket.io': {
        target: `http://localhost:${SERVER_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
