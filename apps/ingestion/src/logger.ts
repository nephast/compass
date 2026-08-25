// Structured JSON logging (COMPASS-29 arriving early — it's much cheaper to
// start here than to retrofit once handlers exist). One line of JSON per
// event, on stdout, so CloudWatch Logs Insights can query fields directly
// instead of regexing free text.
//
// Deliberately not a logging library: nothing here needs transports,
// redaction or child loggers yet. Revisit when a real service (COMPASS-17)
// needs request-scoped context and trace IDs (COMPASS-31).

type Level = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

function emit(level: Level, message: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));
}

export const logger = {
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
