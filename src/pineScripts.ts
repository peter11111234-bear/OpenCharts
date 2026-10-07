/**
 * Pine Script manifest for the Vela workspace (/vela page).
 *
 * Drop TradingView scripts as .pine files in src/pine/ — they are bundled at
 * build time via import.meta.glob and appear in the workspace indicator picker
 * under "My Pine Scripts". User-saved scripts from the pine library
 * (opencharts.pine.lib) are merged in via `combinedManifestEntries()`.
 *
 * Conventions (parsed from leading comments, all optional):
 *   //@enabled    → auto-attach the script to every fresh chart (default off)
 *   //@category=X → picker grouping label (default "My Pine Scripts")
 *   File name is the picker display name (script's own indicator() title is
 *   still what the chart legend shows).
 */

import { pineLibList } from "./pine/lib/pineLib.ts";

export interface PineManifestEntry {
  name: string;
  script: string;
  language?: string;
  enabled?: boolean;
  category?: string;
}

// Vite bundles each file's text at build time; filename = key.
const modules = import.meta.glob("./pine/*.pine", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function fileLabel(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.pine$/, "");
}

function meta(source: string): { enabled: boolean; category: string } {
  const enabled = /^\/\/@enabled\b/m.test(source);
  const cat = /^\/\/@category=(.+)$/m.exec(source);
  return { enabled, category: cat?.[1]?.trim() || "My Pine Scripts" };
}

export function loadPineManifest(): PineManifestEntry[] {
  return Object.entries(modules)
    .sort(([a], [b]) => fileLabel(a).localeCompare(fileLabel(b)))
    .map(([path, script]) => ({
      name: fileLabel(path),
      script,
      language: "pine",
      ...meta(script),
    }));
}

/**
 * Merge the user's personal script library into the manifest — they appear in
 * the Indicators picker under "My scripts" alongside the bundled src/pine files.
 */
export function combinedManifestEntries(): PineManifestEntry[] {
  const mine = pineLibList().map(s => ({
    name: s.name,
    script: s.source,
    language: 'pine' as const,
    category: 'My scripts',
  }));
  return [...loadPineManifest(), ...mine];
}
