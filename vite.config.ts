import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "path";

/** Dev-only sink for the order guard (src/services/guard/guardRuntime.ts):
 *  POST /__guard-log appends one JSON object per line to logs/order-guard.jsonl.
 *  A body that is not a JSON object gets 400 and writes nothing. */
function guardLogPlugin(): Plugin {
  const file = path.resolve(__dirname, "logs/order-guard.jsonl");
  return {
    name: "order-guard-log",
    configureServer(server) {
      server.middlewares.use("/__guard-log", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          let event: unknown = null;
          try {
            event = JSON.parse(body);
          } catch {
            event = null;
          }
          if (event === null || typeof event !== "object" || Array.isArray(event)) {
            res.statusCode = 400;
            res.end();
            return;
          }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, JSON.stringify(event) + "\n");
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), guardLogPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@propsim/types": path.resolve(__dirname, "./src/vendor/types.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        pineEditor: path.resolve(__dirname, "pine-editor.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/react-router") ||
              id.includes("/@radix-ui/") ||
              id.includes("/@tanstack/") ||
              id.includes("/zustand/") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("/lucide-react/")) {
              return "vendor-icons";
            }
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    // Never auto-increment: a port collision means a stray vite is already
    // serving this repo — fail loudly instead of spawning :5174/:5175
    // zombies (the multi-tab/multi-server incident of 2026-10-07).
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
      // Local shioaji server (行情/下單 Key 都在 server 端，前端不碰).
      // NOTE: vite proxy keeps the matched prefix — strip it, the server
      // only serves /api/... (without it salvo answers 405).
      "/shioaji": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/shioaji/, ""),
      },
      // Jev decision sidecar (OPENROUTER_API_KEY 只在 server 端).
      "/jev": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jev/, ""),
      },
    },
  },
});
