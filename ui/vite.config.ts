/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The built interface goes into harm/static/app/ and is committed, so HaRM runs with Python only.
// `npm run dev` serves it with live reload and passes /api through to a HaRM on port 8077 (./run.sh).
const harm = process.env.HARM_URL ?? "http://127.0.0.1:8077";

export default defineConfig(({ command }) => ({
  plugins: [react({ jsxImportSource: "harm-jsx" })],
  resolve: { alias: { "harm-jsx": path.resolve(import.meta.dirname, "src/jsx") } },
  base: command === "build" ? "/static/app/" : "/",
  build: {
    outDir: "../harm/static/app",
    emptyOutDir: true,
    assetsDir: "assets",
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5177,
    proxy: Object.fromEntries(["/api", "/static/collect", "/static/vendor", "/static/icon", "/static/theme.js", "/harm-ca.crt", "/sw.js"]
      .map(p => [p, { target: harm, changeOrigin: false, secure: false }])),
  },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"] },
}));
