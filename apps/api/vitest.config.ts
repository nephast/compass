import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env — the defaults below match a stock `npm run local:up` stack
}
process.env.LOCALSTACK_ENDPOINT ??= "http://localhost:4566";
process.env.DATABASE_URL ??= "postgresql://compass:compass@localhost:5432/compass";

// test/unit: no Docker. test/integration: real pgvector + LocalStack S3, fake LLMs.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 15_000 },
});
