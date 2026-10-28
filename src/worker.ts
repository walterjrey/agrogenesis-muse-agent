import { runSessionSlice, DEFAULT_SLICE_CYCLES, type AgentDependencies } from "./library.js";
import { SessionLockedError, type ControllableBackend } from "./autonomy/storage.js";

export interface WorkerOptions {
  deps: Omit<AgentDependencies, "backend"> & { backend: ControllableBackend };
  /**
   * Process-level kill switch for state-changing farm actions (default false). A session that allows mutations is
   * never run by a worker that does not, so it cannot silently degrade into an observe-only run and be marked completed.
   */
  mutationsAllowed?: boolean;
  /** Decision cycles per slice (default 3). A slice is the unit of work between control checks. */
  sliceCycles?: number;
  /** Sessions claimed per polling pass (default 3). Slices run sequentially. */
  batchSize?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | { type: "slice_started"; sessionId: string }
  | { type: "slice_finished"; sessionId: string; status: string; stopReason: string | null; finished: boolean }
  | { type: "skipped_locked"; sessionId: string }
  | { type: "skipped_mutations_disabled"; sessionId: string }
  | { type: "cancelled"; sessionId: string }
  | { type: "slice_failed"; sessionId: string; error: string }
  | { type: "stopped" };

const truncate = (message: string): string => message.replace(/\s+/g, " ").slice(0, 300);

/** Finalizes a session whose cancellation was requested, under the lease so it cannot race a running slice. */
async function finalizeCancelled(backend: ControllableBackend, sessionId: string): Promise<void> {
  const lease = await backend.acquire(sessionId);
  try {
    const state = await backend.load(sessionId);
    if (state.status === "paused" || state.status === "running") {
      await lease.save({ ...state, status: "stopped", stopReason: "cancelled_by_operator" });
    }
  } finally {
    await lease.release();
  }
}

/**
 * One polling pass: finalize cancellations, then run one bounded slice for each runnable session. Safe to run from
 * several workers at once because each slice starts by acquiring the session lease; a loser skips the session.
 */
export async function runWorkerOnce(options: WorkerOptions): Promise<number> {
  const { backend } = options.deps;
  const emit = options.onEvent ?? (() => undefined);
  const batch = options.batchSize ?? 3;
  let slices = 0;

  for (const sessionId of await backend.listCancelRequested(batch)) {
    if (options.signal?.aborted) return slices;
    try {
      await finalizeCancelled(backend, sessionId);
      await backend.settleControl(sessionId, { stopRunning: true, lastError: null });
      emit({ type: "cancelled", sessionId });
    } catch (error) {
      if (!(error instanceof SessionLockedError)) emit({ type: "slice_failed", sessionId, error: truncate(String(error instanceof Error ? error.message : error)) });
    }
  }

  for (const sessionId of await backend.listRunnable(batch)) {
    if (options.signal?.aborted) return slices;
    try {
      const stored = await backend.load(sessionId);
      if (stored.config.mutationsEnabled && !options.mutationsAllowed) {
        await backend.settleControl(sessionId, { stopRunning: true, lastError: "This worker has mutations disabled; the session allows them." });
        emit({ type: "skipped_mutations_disabled", sessionId });
        continue;
      }
      emit({ type: "slice_started", sessionId });
      const result = await runSessionSlice(options.deps, {
        sessionId,
        mutationsEnabled: options.mutationsAllowed === true,
        sliceCycles: options.sliceCycles ?? DEFAULT_SLICE_CYCLES,
      });
      slices += 1;
      const { status, stopReason } = result.state;
      const resumable = status === "paused" && stopReason === "slice_complete";
      await backend.settleControl(sessionId, { stopRunning: !resumable, lastError: resumable || status === "completed" ? null : truncate(`${status}: ${stopReason ?? "unknown"}`) });
      emit({ type: "slice_finished", sessionId, status, stopReason, finished: result.finished });
    } catch (error) {
      if (error instanceof SessionLockedError) {
        emit({ type: "skipped_locked", sessionId });
        continue;
      }
      const message = truncate(String(error instanceof Error ? error.message : error));
      await backend.settleControl(sessionId, { stopRunning: true, lastError: message }).catch(() => undefined);
      emit({ type: "slice_failed", sessionId, error: message });
    }
  }
  return slices;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Long-running worker loop for a Background Worker / separate process. Never call it from a request handler.
 * On abort it finishes the slice in progress (bounded) and returns; if the process is killed instead, the lease expires
 * and the next worker resumes the session from its journal.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const interval = options.pollIntervalMs ?? 5_000;
  while (!options.signal?.aborted) {
    let slices = 0;
    try {
      slices = await runWorkerOnce(options);
    } catch (error) {
      options.onEvent?.({ type: "slice_failed", sessionId: "-", error: truncate(String(error instanceof Error ? error.message : error)) });
    }
    if (slices === 0) await sleep(interval, options.signal);
  }
  options.onEvent?.({ type: "stopped" });
}
