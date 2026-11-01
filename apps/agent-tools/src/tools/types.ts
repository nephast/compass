import type { ToolSpec } from "@compass/llm";

// A tool is its spec (what the model sees) plus an executor. The spec's
// inputSchema is ALSO the validator (registry.ts compiles it with Ajv), so the
// contract the model is told about and the contract that is enforced cannot
// drift apart -- there is exactly one of it.
export interface Tool<Input = Record<string, unknown>> {
  spec: ToolSpec;
  /** Read-only by construction. A write tool needs an ADR first (CLAUDE.md). */
  readonly readOnly: true;
  execute(input: Input): Promise<unknown>;
}
