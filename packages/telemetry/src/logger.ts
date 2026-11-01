import { AsyncLocalStorage } from "node:async_hooks";

// Structured JSON logging (COMPASS-29): one JSON object per line on stdout, so
// CloudWatch Logs Insights queries fields directly instead of regexing text.
//
// Request-scoped fields (traceId, requestId, user) live in AsyncLocalStorage,
// so a log call deep inside the RAG flow carries them without every function
// threading a logger parameter through. Still deliberately not a library: no
// transports, no levels config, nothing that can fail.

type Level = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const context = new AsyncLocalStorage<LogFields>();
const service = process.env.SERVICE_NAME ?? "compass";

export function withLogContext<T>(fields: LogFields, work: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, work);
}

/**
 * For framework hooks that cannot wrap the handler in a callback (Fastify's
 * onRequest): binds the fields to the rest of the current async execution.
 */
export function enterLogContext(fields: LogFields): void {
  context.enterWith({ ...context.getStore(), ...fields });
}

/** Adds fields to the current request's context, e.g. the user once known. */
export function addLogContext(fields: LogFields): void {
  const store = context.getStore();
  if (store) Object.assign(store, fields);
}

export function logContext(): LogFields {
  return context.getStore() ?? {};
}

function serialiseError(value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function emit(level: Level, message: string, fields: LogFields = {}): void {
  const record: LogFields = {
    level,
    message,
    time: new Date().toISOString(),
    service,
    ...context.getStore(),
  };
  for (const [key, value] of Object.entries(fields)) record[key] = serialiseError(value);
  console.log(JSON.stringify(record));
}

export const logger = {
  debug: (message: string, fields?: LogFields) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", message, fields);
  },
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
