import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "path";

/** Dev-only sink for the order guard (src/services/guard/guardRuntime.ts):
 *  POST /__guard-log appends one JSON object per line to logs/order-guard.jsonl.
 *  A body that is not a JSON object gets 400 and writes nothing.
 *
 *  The audit log decides whether Phase 2 turns the guard on, so a write from
 *  anywhere but this app would corrupt that decision:
 *  - only same-origin requests (the browser sends Origin on cross-site POSTs,
 *    but not on same-origin ones, so an absent Origin is allowed too);
 *  - only POST, so a stray GET cannot be mistaken for a write;
 *  - a body cap, so one request cannot fill the disk;
 *  - the log is denied to the static file handler, so the dev server cannot
 *    hand it out as a downloadable file. */
const GUARD_LOG_MAX_BODY = 64 * 1024;

function guardLogPlugin(): Plugin {
  const file = path.resolve(__dirname, "logs/order-guard.jsonl");
  return {
    name: "order-guard-log",
    configureServer(server) {
      server.middlewares.use("/__guard-log", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const origin = req.headers.origin;
        if (origin) {
          const host = req.headers.host;
          // "null" (sandboxed iframe) and anything unparseable is not us.
          let originHost = "";
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = "";
          }
          if (!host || !originHost || originHost !== host) {
            res.statusCode = 403;
            res.end();
            return;
          }
        }
        let body = "";
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk) => {
          if (tooLarge) return;
          // chunk is a string: its length counts characters, so a multi-byte
          // body would slip past a byte cap. Measure the real byte size.
          size += Buffer.byteLength(chunk);
          if (size > GUARD_LOG_MAX_BODY) {
            // Stop accumulating: a client that keeps sending must not be able
            // to fill the server's memory.
            tooLarge = true;
            body = "";
            return;
          }
          body += chunk;
        });
        req.on("end", () => {
          if (tooLarge) {
            res.statusCode = 413;
            res.end();
            return;
          }
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
      // The audit log is not a public file: keep the whole logs/ directory out
      // of the static handler. A raw prefix check is not enough: the static
      // handler decodes and normalizes the path first, so "/%6Cogs/x.jsonl"
      // and "/./logs/x.jsonl" both reach the file, and the filesystem is
      // case-insensitive so "/Logs/x.jsonl" does too.
      server.middlewares.use((req, res, next) => {
        const raw = (req.url ?? "").split("?")[0] ?? "";
        let decoded = raw;
        try {
          decoded = decodeURIComponent(raw);
        } catch {
          decoded = raw;
        }
        const normalized = path.posix.normalize(decoded.replace(/\\/g, "/"));
        if (/(^|\/)logs(\/|$)/i.test(normalized)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        next();
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
    // Runtime logs (the guard audit log, watchdog output) are not public files.
    // The default deny list only covers .env and .git, so logs/ would be served.
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "logs/**"],
    },
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
