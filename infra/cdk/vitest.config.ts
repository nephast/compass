import { defineConfig } from "vitest/config";

// Synth runs esbuild for the ingestion Lambda; give it room on a cold cache.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
