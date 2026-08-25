import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // Lambda create + cold start (a first-ever run pulls the runtime image,
    // can take over a minute) + async S3 notification + log polling is
    // slower than a unit test budget.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
