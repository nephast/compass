import { defineConfig } from "vitest/config";

// Same .env loading as apps/ingestion: the integration tier needs real AWS
// credentials from the ambient chain, and the region from the environment.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env — the ambient AWS credential chain and defaults below still work
}
process.env.AWS_REGION ??= "eu-west-1";

// Tiers are directories, matching apps/ingestion: test/unit never touches the
// network and runs in CI; test/integration calls Bedrock for real and is
// skipped unless RUN_LIVE_LLM_TESTS is set, so CI neither spends nor needs
// credentials.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
