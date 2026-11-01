import { Ajv, type ValidateFunction } from "ajv";
import type { ToolSpec } from "@compass/llm";
import type { Tool } from "./tools/types.js";

// The allow-list (COMPASS-21). Built once at boot from a fixed array and then
// frozen: there is no method to add a tool at runtime, and nothing the model
// says can reach one that is not in this map.

export type ValidationResult =
  { ok: true; input: Record<string, unknown> } | { ok: false; error: string };

export interface RegisteredTool {
  tool: Tool<never>;
  validate: ValidateFunction;
}

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, RegisteredTool>;

  constructor(tools: Tool<never>[]) {
    // useDefaults fills `days: 7` etc.; removeAdditional is OFF on purpose --
    // an unexpected property is rejected and reported, not silently dropped,
    // because a model inventing parameters is worth seeing in the logs.
    const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: true });
    const entries = new Map<string, RegisteredTool>();
    for (const tool of tools) {
      if (entries.has(tool.spec.name)) throw new Error(`duplicate tool ${tool.spec.name}`);
      if (tool.readOnly !== true) throw new Error(`${tool.spec.name} is not read-only`);
      entries.set(tool.spec.name, { tool, validate: ajv.compile(tool.spec.inputSchema) });
    }
    this.tools = entries;
    Object.freeze(this);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((entry) => entry.tool.spec);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Validates BEFORE execution; the input object is cloned, never shared. */
  validate(name: string, input: unknown): ValidationResult {
    const entry = this.tools.get(name);
    if (!entry) return { ok: false, error: `"${name}" is not an allowed tool` };
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: "arguments must be a JSON object" };
    }
    const copy = structuredClone(input) as Record<string, unknown>;
    if (!entry.validate(copy)) {
      const detail = (entry.validate.errors ?? [])
        .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`)
        .join("; ");
      return { ok: false, error: `invalid arguments: ${detail}` };
    }
    return { ok: true, input: copy };
  }

  async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`"${name}" is not an allowed tool`);
    return entry.tool.execute(input as never);
  }
}
