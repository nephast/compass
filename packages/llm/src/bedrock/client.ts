import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

// The client lives beside the adapters so index.ts -- the wiring -- imports no
// vendor SDK at all. That is what keeps
// `grep -rl "@aws-sdk/client-bedrock" packages/llm/src` down to this directory,
// which is the check that the abstraction is real rather than asserted.

let shared: BedrockRuntimeClient | undefined;

/**
 * One client per process, reused across Lambda invocations in the same
 * execution environment — the same container-reuse pattern as the S3 and
 * Postgres clients in apps/ingestion.
 */
export function bedrockClient(region: string | undefined): BedrockRuntimeClient {
  shared ??= new BedrockRuntimeClient(region === undefined ? {} : { region });
  return shared;
}

export type { BedrockRuntimeClient };
