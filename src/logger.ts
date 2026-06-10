// Structured stderr logger for the MCP server. Stderr (not stdout) because
// stdio transport reserves stdout for JSON-RPC frames — anything else there
// breaks the agent's MCP client. One JSON object per line so the agent's
// parent process can parse logs without a regex.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  // Tool / resource that triggered the log line — kept short so log scans
  // are readable.
  tool?: string;
  productId?: string;
  specId?: string;
  durationMs?: number;
  errorCode?: string;
  // Free-form for one-off context. Keys never include token plaintext.
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel: LogLevel =
  (process.env.KSTONEBASE_LOG_LEVEL as LogLevel | undefined) ?? "info";

function emit(level: LogLevel, message: string, context: LogContext = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg: message,
    ...context,
  });
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, ctx?: LogContext) => emit("debug", message, ctx),
  info: (message: string, ctx?: LogContext) => emit("info", message, ctx),
  warn: (message: string, ctx?: LogContext) => emit("warn", message, ctx),
  error: (message: string, ctx?: LogContext) => emit("error", message, ctx),
};
