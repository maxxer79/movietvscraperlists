import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During dev, proxy /api to the backend so the SPA and API share an origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8088",
        changeOrigin: true,
        // Large Fandango libraries can take several minutes to sync.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
