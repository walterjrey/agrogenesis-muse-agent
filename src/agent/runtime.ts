import { compactHistory, type ToolCallMeta } from "./history.js";
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ModelApiError, type ModelProvider, type ModelResponse, type ModelToolCall } from "../model/meta.js";
import { SpendLimitError } from "../model/spendGuard.js";
import { classifyResponse, describeResponse, formatResponseDiagnostic, RETRYABLE_CLASSIFICATIONS } from "../model/responseClass.js";
import type { SimulatorClient } from "../simulator/client.js";
import { DEFAULT_LIMITS, RunPolicy, type ExecutionMode, type RunLimits } from "./policy.js";
import { SYSTEM_PROMPT, userBrief } from "./prompt.js";
import { createToolRegistry, newMutationId, toolSpecs, type MutationJournal, type RegisteredTool, type ToolContext, type ToolOutcome, type ToolState } from "./tools.js";
import { RunTrace } from "./trace.js";

export type StopReason = "final_answer" | "model_call_limit" | "cost_limit" | "model_error" | "empty_response" | "wall_clock_limit";

export interface RunTotals {
  /** Successful logical model calls only (each may have taken several physical HTTP attempts; see modelRetryAttempts). */
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  acceptedMutations: number;
  mutationAttempts: number;
  /** Accepted/attempted observation-only actions (inspectField/surveyField/inspectLocation/sampleSoil/inspectPestPressure); never counted against acceptedMutations. */
  acceptedInspections: number;
  inspectionAttempts: number;
  advancedSimSeconds: number;
  /** Logical model calls that never produced a usable response, after the provider's retry policy was exhausted. Excludes local spend-guard refusals, which never reach the network. */
  failedModelCalls: number;
  /** Physical HTTP retry attempts beyond the first, summed across every logical call (successful or failed) in this run. */
  modelRetryAttempts: number;
}

export interface RunResult {
  runId: string;
  status: "completed" | "limited" | "failed";
  stopReason: StopReason;
  mode: ExecutionMode;
  modelId: string;
  gameId: string;
  finalSummary: string | null;
  totals: RunTotals;
  error: string | null;
  traceFile: string | null;
}

export interface RunOptions {
  provider: ModelProvider;
  client: SimulatorClient;
  gameId: string;
  mode: ExecutionMode;
  limits?: Partial<RunLimits>;
  /** Directory for the JSONL audit trail; null keeps the trace in memory only. */
  traceDirectory?: string | null;
  runId?: string;
  brief?: string;
  newMutationId?: () => string;
  retryDelayMs?: number;
  maxMutationRetries?: number;
  tools?: RegisteredTool[];
  systemPrompt?: string;
  /** Seeds the tool state, e.g. the revision of an observation the caller already collected and showed to the model. */
  initialState?: Partial<ToolState>;
  /** Durable record of state-changing requests (see MutationJournal). */
  journal?: MutationJournal;
  /** Epoch milliseconds after which no further model request is started. */
  deadlineMs?: number;
  /** Aborts an in-flight model request or retry backoff (e.g. worker shutdown). */
  signal?: AbortSignal;
  /** Asked when the model is about to give its final answer; a non-null message is sent back once instead (e.g. to ask for a missing plan). */
  beforeFinal?: () => string | null;
  /** Autonomy cycle this run belongs to, if any; included in model.request/model.response/model.error trace entries so
   * per-call token usage (logged by the provider) can be correlated back to a cycle without parsing the run id. */
  cycle?: number;
}

const MAX_TOOL_RESULT_CHARS = 60_000;
const FINAL_NUDGE = "No further tool calls are available. Using only what you have observed, give your final summary now.";

export async function runAgent(options: RunOptions): Promise<RunResult & { trace: RunTrace; state: ToolState }> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const policy = new RunPolicy(options.mode, limits);
  const runId = options.runId ?? randomUUID();
  const trace = new RunTrace(runId, options.traceDirectory === undefined ? "logs/runs" : options.traceDirectory);
  const registry = options.tools ?? createToolRegistry();
  const state: ToolState = { observedRevision: null, eventCursor: 0, mutationLocked: false, ...options.initialState };
  const context: ToolContext = {
    client: options.client,
    gameId: options.gameId,
    policy,
    trace,
    state,
    newMutationId: options.newMutationId ?? newMutationId,
    retryDelayMs: options.retryDelayMs ?? 400,
    maxMutationRetries: options.maxMutationRetries ?? 2,
    ...(options.journal ? { journal: options.journal } : {}),
  };
  const exposed = registry.filter((tool) => policy.isExposed(tool));
  const tools = toolSpecs(registry, (tool) => policy.isExposed(tool));
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0, failedModelCalls: 0, modelRetryAttempts: 0 };

  trace.record("run.start", { runId, gameId: options.gameId, modelId: options.provider.modelId, mode: options.mode, limits, exposedTools: exposed.map((t) => t.name) });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: options.systemPrompt ?? SYSTEM_PROMPT },
    { role: "user", content: options.brief ?? userBrief(options.mode) },
  ];

  let stopReason: StopReason = "model_call_limit";
  let finalSummary: string | null = null;
  let error: string | null = null;
  let toolsEnabled = true;
  let nudgedBeforeFinal = false;
  let retriedUnusable = false;
  const callMeta = new Map<string, ToolCallMeta>();

  for (let step = 1; ; step += 1) {
    if (policy.modelCalls >= limits.maxModelCalls) { stopReason = "model_call_limit"; break; }
    if (totals.estimatedCostUsd >= limits.maxCostUsd) { stopReason = "cost_limit"; break; }
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) { stopReason = "wall_clock_limit"; break; }
    if (toolsEnabled && policy.modelCalls === limits.maxModelCalls - 1 && policy.modelCalls > 0) {
      toolsEnabled = false;
      messages.push({ role: "user", content: FINAL_NUDGE });
    }

    let response: ModelResponse;
    try {
      trace.record("model.request", { step, cycle: options.cycle ?? null, messageCount: messages.length, toolsOffered: toolsEnabled ? tools.length : 0 });
      response = await options.provider.complete({ messages: compactHistory(messages, callMeta), ...(toolsEnabled ? { tools } : {}), maxOutputTokens: limits.maxOutputTokens, ...(options.signal ? { signal: options.signal } : {}), ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) });
    } catch (caught) {
      stopReason = caught instanceof SpendLimitError ? "cost_limit" : "model_error";
      error = caught instanceof Error ? caught.message : String(caught);
      // A spend-guard refusal never reaches the network, so it is not a failed request and carries no retry attempts.
      if (!(caught instanceof SpendLimitError)) {
        totals.failedModelCalls += 1;
        totals.modelRetryAttempts += Math.max(0, (caught instanceof ModelApiError ? Math.max(1, caught.attempts.length) : 1) - 1);
      }
      trace.record("model.error", { step, cycle: options.cycle ?? null, kind: caught instanceof ModelApiError ? caught.kind : caught instanceof SpendLimitError ? caught.limit : "unknown", message: error, ...(caught instanceof ModelApiError ? { status: caught.status ?? null, code: caught.code, requestId: caught.requestId, attempts: caught.attempts } : {}) });
      break;
    }

    policy.modelCalls += 1;
    totals.inputTokens += response.usage?.promptTokens ?? 0;
    totals.outputTokens += response.usage?.completionTokens ?? 0;
    totals.cachedTokens += response.usage?.cachedPromptTokens ?? 0;
    totals.estimatedCostUsd += response.estimatedCostUsd ?? 0;
    // One logical call may have needed several physical HTTP attempts (timeouts/429/5xx) before it succeeded.
    totals.modelRetryAttempts += Math.max(0, (response.attempts?.length ?? 1) - 1);
    trace.record("model.response", {
      step,
      cycle: options.cycle ?? null,
      model: response.model,
      finishReason: response.finishReason,
      requestId: response.requestId,
      attempts: response.attempts?.length ?? 1,
      usage: response.usage,
      estimatedCostUsd: response.estimatedCostUsd,
      latencyMs: response.latencyMs,
      assistantText: response.content,
      toolCalls: response.toolCalls.map((c) => ({ id: c.id, name: c.name })),
    });
    const classification = classifyResponse(response);
    if (classification !== "ok") {
      // HTTP 200 but nothing executable or usable: a failed logical call. It is already counted once in modelCalls
      // (and priced), so only failedModelCalls moves. The unusable message is never replayed to the model.
      totals.failedModelCalls += 1;
      const diagnostic = describeResponse(response, classification);
      trace.record("model.unusable_response", { step, cycle: options.cycle ?? null, ...diagnostic });
      const budgetLeft = policy.modelCalls < limits.maxModelCalls && totals.estimatedCostUsd < limits.maxCostUsd && (options.deadlineMs === undefined || Date.now() < options.deadlineMs) && !options.signal?.aborted;
      if (RETRYABLE_CLASSIFICATIONS.has(classification) && !retriedUnusable && budgetLeft) {
        retriedUnusable = true;
        totals.modelRetryAttempts += 1;
        continue;
      }
      stopReason = "empty_response";
      error = formatResponseDiagnostic(diagnostic);
      break;
    }
    retriedUnusable = false;

    messages.push(response.assistantMessage);
    for (const call of response.toolCalls) callMeta.set(call.id, { name: call.name, arguments: call.arguments });

    if (response.toolCalls.length === 0 && toolsEnabled && !nudgedBeforeFinal && policy.modelCalls < limits.maxModelCalls - 1) {
      const nudge = options.beforeFinal?.() ?? null;
      if (nudge) {
        nudgedBeforeFinal = true;
        messages.push({ role: "user", content: nudge });
        continue;
      }
    }
    if (response.toolCalls.length === 0 || !toolsEnabled) {
      finalSummary = response.content?.trim() || null;
      stopReason = finalSummary ? "final_answer" : "empty_response";
      break;
    }

    for (const [index, call] of response.toolCalls.entries()) {
      const outcome = await resolveToolCall(call, index, response.toolCalls.length, step);
      messages.push({ role: "tool", tool_call_id: call.id, content: serialize(outcome) });
    }
    if (policy.toolCalls >= limits.maxTotalToolCalls && toolsEnabled) {
      toolsEnabled = false;
      messages.push({ role: "user", content: FINAL_NUDGE });
    }
  }

  const finished = stopReason === "final_answer";
  const result: RunResult = {
    runId,
    status: finished ? "completed" : stopReason === "model_error" ? "failed" : "limited",
    stopReason,
    mode: options.mode,
    modelId: options.provider.modelId,
    gameId: options.gameId,
    finalSummary,
    totals: {
      modelCalls: policy.modelCalls,
      toolCalls: policy.toolCalls,
      ...totals,
      acceptedMutations: policy.acceptedMutations,
      mutationAttempts: policy.mutationAttempts,
      acceptedInspections: policy.acceptedInspections,
      inspectionAttempts: policy.inspectionAttempts,
      advancedSimSeconds: policy.advancedSimSeconds,
    },
    error,
    traceFile: trace.file,
  };
  trace.record("run.end", { ...result });
  return { ...result, trace, state };

  async function resolveToolCall(call: ModelToolCall, index: number, callsInStep: number, step: number): Promise<ToolOutcome> {
    const tool = registry.find((t) => t.name === call.name);
    const finish = (outcome: ToolOutcome, args?: unknown): ToolOutcome => {
      trace.record("tool.result", { step, toolCallId: call.id, name: call.name, ...(outcome.ok ? { ok: true, result: outcome.data } : { ok: false, error: outcome.error }), args: args ?? null });
      return outcome;
    };
    const deny = (code: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome => finish({ ok: false, error: { code, message, ...extra } });

    trace.record("tool.request", { step, toolCallId: call.id, name: call.name, rawArguments: call.arguments.slice(0, 2000) });
    if (!tool) return deny("unknown_tool", `No tool named "${call.name}". Available: ${exposed.map((t) => t.name).join(", ")}.`);
    const exposure = policy.authorize(tool, {});
    if (!policy.isExposed(tool) && !exposure.allowed) return deny(exposure.code, exposure.message);
    if (index >= limits.maxToolCallsPerStep) return deny("per_step_limit", `At most ${limits.maxToolCallsPerStep} tool calls are executed per step; this call was not executed.`);
    if (policy.toolCalls >= limits.maxTotalToolCalls) return deny("tool_call_limit", "The total tool-call limit for this run is reached; this call was not executed.");
    policy.toolCalls += 1;

    let raw: unknown;
    try {
      raw = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    } catch {
      return deny("invalid_arguments", "Arguments must be a valid JSON object.");
    }
    const parsed = tool.parse(raw);
    if (!parsed.ok) return deny("invalid_arguments", "Arguments did not match the tool schema.", { issues: parsed.issues });
    if (tool.mutating && callsInStep > 1) {
      return deny("mutation_must_be_alone", `${tool.name} changes the farm and must be called alone, after you have seen the results of any other calls. It was not executed; call it again by itself.`);
    }
    const decision = policy.authorize(tool, parsed.args);
    if (!decision.allowed) return deny(decision.code, decision.message);

    trace.record("tool.execute", { step, toolCallId: call.id, name: call.name, args: parsed.args });
    try {
      return finish(await tool.run(context, parsed.args), parsed.args);
    } catch (caught) {
      trace.record("tool.exception", { step, toolCallId: call.id, name: call.name, message: caught instanceof Error ? caught.message : String(caught) });
      return finish({ ok: false, error: { code: "internal_error", message: "The tool failed unexpectedly." } }, parsed.args);
    }
  }
}

function serialize(outcome: ToolOutcome): string {
  const text = JSON.stringify(outcome.ok ? { ok: true, data: outcome.data } : { ok: false, error: outcome.error });
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return JSON.stringify({ ok: false, error: { code: "result_too_large", message: `The result exceeded ${MAX_TOOL_RESULT_CHARS} characters and was withheld. Narrow the request (for example with a category filter).` } });
}
