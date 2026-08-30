import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser is NOT inside the sandbox, so it must never call localhost:8000
// directly. All API traffic uses relative /api/* URLs which Vite proxies to the
// FastAPI service running alongside it.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        timeout: 120000,
        proxyTimeout: 120000,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: true } },
  },
});
