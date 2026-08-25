import { defineConfig } from "vitest/config";

// Load the repo-root .env so tests see DATABASE_URL / LOCALSTACK_ENDPOINT
// without every script needing --env-file. Missing .env is fine: the
// defaults below match a stock `docker compose up` stack, so a fresh clone
// runs the tests without a confusing "undefined connection string" failure.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env — fall through to defaults
}
process.env.LOCALSTACK_ENDPOINT ??= "http://localhost:4566";
process.env.DATABASE_URL ??= "postgresql://compass:compass@localhost:5432/compass";

// Tiers are directories, not filename suffixes, so the scripts that select
// them stay obvious: test/unit (no Docker, runs in CI), test/integration
// (LocalStack + Postgres, the save-loop), test/wiring (deploys a real
// Lambda, minutes on a cold start).
export default defineConfig({
  test: {
    // One LocalStack and one Postgres are shared by every file, so files
    // must not race each other. Each file already scopes itself to a unique
    // bucket; this is the second belt.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
