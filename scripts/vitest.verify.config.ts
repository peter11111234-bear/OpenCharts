/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import path from "path";

// Throwaway config so scripts/verify_adv_*.test.ts probes are discoverable.
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["scripts/verify_adv_*.test.ts"],
    css: false,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "../src") } },
});
