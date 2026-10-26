import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /key|token|secret|password|authorization|cookie|database_url/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.replace(/Bearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** JSONL file path; the directory is created if needed. */
  file?: string;
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  if (options.file) mkdirSync(dirname(options.file), { recursive: true });
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    log(level, event, fields = {}) {
      if (ORDER[level] < min) return;
      const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) });
      sink(line);
      if (options.file) appendFileSync(options.file, `${line}\n`);
    },
  };
}

export const silentLogger: Logger = { log() {} };
