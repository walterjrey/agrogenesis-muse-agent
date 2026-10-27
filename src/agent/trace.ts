import { join } from "node:path";
import { createLogger, type Logger } from "../logging/logger.js";

export interface TraceEntry {
  seq: number;
  ts: string;
  event: string;
  [field: string]: unknown;
}

/**
 * Append-only structured audit trail of one run (JSONL on disk plus an in-memory copy). Entries pass through
 * the shared logger redaction, so credentials never reach the file. Only data the model explicitly produced
 * (assistant text, tool-call arguments, rationale fields) is recorded as "reasoning"; no hidden chain of thought.
 */
export class RunTrace {
  readonly entries: TraceEntry[] = [];
  readonly file: string | null;
  private readonly logger: Logger;
  private seq = 0;

  constructor(readonly runId: string, directory: string | null) {
    this.file = directory ? join(directory, `${runId}.jsonl`) : null;
    this.logger = createLogger({ level: "debug", ...(this.file ? { file: this.file } : {}), sink: () => {} });
  }

  record(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ seq: ++this.seq, ts: new Date().toISOString(), event, ...fields });
    this.logger.log("info", event, { seq: this.seq, runId: this.runId, ...fields });
  }
}
