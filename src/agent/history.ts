import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Replaces tool results that a newer result of the same kind has superseded with a stub that keeps the facts needed
 * to reason about staleness (tool, revision, simulated time). The newest result of each kind is never touched, and
 * neither are errors, mutation results or any assistant/user message, so uncertainty, conflicts and safety text
 * are always preserved in full.
 */
const SUPERSEDABLE = new Set(["observe_snapshot", "observe_farm", "observe_fields", "list_available_actions", "describe_action", "get_action_status", "get_recent_events"]);

export interface ToolCallMeta {
  name: string;
  arguments: string;
}

/** A successful call of one of these changes the farm or the clock, so every earlier read result is stale. */
const STATE_CHANGING = new Set(["execute_action", "advance_time", "wait_for_operation", "wait_for_checkpoint"]);

const keyOf = (meta: ToolCallMeta): string => (meta.name === "observe_snapshot" ? meta.name : `${meta.name}:${meta.arguments}`);

function stubFor(name: string, content: string): string | null {
  let parsed: { ok?: boolean; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.ok !== true) return null;
  const data = parsed.data ?? {};
  const revision = typeof data.revision === "number" ? data.revision : undefined;
  const simTimeS = typeof data.simTimeS === "number" ? data.simTimeS : undefined;
  return JSON.stringify({ ok: true, superseded: true, tool: name, ...(revision !== undefined ? { revision } : {}), ...(simTimeS !== undefined ? { simTimeS } : {}), note: "Older result omitted to save context; a newer result of the same kind appears later in this conversation. Do not rely on this stale data." });
}

/** Returns a new message list; the input is not mutated. */
export function compactHistory(messages: ChatCompletionMessageParam[], calls: ReadonlyMap<string, ToolCallMeta>): ChatCompletionMessageParam[] {
  const lastByKey = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    const meta = calls.get(message.tool_call_id);
    if (meta && SUPERSEDABLE.has(meta.name)) lastByKey.set(keyOf(meta), index);
  });
  let lastChange = -1;
  messages.forEach((message, index) => {
    if (message.role !== "tool" || typeof message.content !== "string") return;
    const meta = calls.get(message.tool_call_id);
    if (meta && STATE_CHANGING.has(meta.name) && message.content.includes("\"ok\":true")) lastChange = index;
  });
  return messages.map((message, index) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;
    const meta = calls.get(message.tool_call_id);
    if (!meta || !SUPERSEDABLE.has(meta.name)) return message;
    if (lastByKey.get(keyOf(meta)) === index && index > lastChange) return message;
    const stub = stubFor(meta.name, message.content);
    return stub && stub.length < message.content.length ? { ...message, content: stub } : message;
  });
}
