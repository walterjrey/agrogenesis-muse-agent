export type ExecutionMode = "observe_only" | "controlled_mutation";

export interface RunLimits {
  maxModelCalls: number;
  maxToolCallsPerStep: number;
  maxTotalToolCalls: number;
  maxOutputTokens: number;
  maxCostPerRequestUsd: number;
  maxCostUsd: number;
  maxAdvanceSecondsPerCall: number;
  maxTotalAdvanceSeconds: number;
  /** Accepted state-changing actions. */
  maxMutations: number;
  /** Submitted actions, accepted or rejected; bounds retries after rejections. */
  maxMutationAttempts: number;
}

export const DEFAULT_LIMITS: Readonly<RunLimits> = {
  maxModelCalls: 10,
  maxToolCallsPerStep: 4,
  maxTotalToolCalls: 20,
  maxOutputTokens: 2048,
  maxCostPerRequestUsd: 0.1,
  maxCostUsd: 0.25,
  maxAdvanceSecondsPerCall: 1800,
  maxTotalAdvanceSeconds: 3600,
  maxMutations: 1,
  maxMutationAttempts: 3,
};

export interface ToolTraits {
  name: string;
  mutating: boolean;
}

export type PolicyDecision = { allowed: true } | { allowed: false; code: string; message: string };

/**
 * Local execution policy. It is the enforcement point for what a run may do; the system prompt is only
 * guidance. The simulator still performs its own authorization and validation on every call.
 */
export class RunPolicy {
  modelCalls = 0;
  toolCalls = 0;
  acceptedMutations = 0;
  mutationAttempts = 0;
  advancedSimSeconds = 0;

  constructor(readonly mode: ExecutionMode, readonly limits: RunLimits = DEFAULT_LIMITS) {}

  isExposed(tool: ToolTraits): boolean {
    return !tool.mutating || this.mode === "controlled_mutation";
  }

  authorize(tool: ToolTraits, args: Record<string, unknown>): PolicyDecision {
    if (!this.isExposed(tool)) {
      return { allowed: false, code: "mutation_disabled", message: "This run is observe-only: state-changing tools are disabled." };
    }
    if (!tool.mutating) return { allowed: true };

    if (tool.name === "execute_action") {
      if (this.acceptedMutations >= this.limits.maxMutations || this.mutationAttempts >= this.limits.maxMutationAttempts) {
        return { allowed: false, code: "mutation_limit_reached", message: `This run may execute at most ${this.limits.maxMutations} action(s) (${this.limits.maxMutationAttempts} submission attempts). The limit is reached.` };
      }
    }
    if (tool.name === "advance_time") {
      const requested = typeof args.requestedSeconds === "number" ? args.requestedSeconds : 0;
      if (requested > this.limits.maxAdvanceSecondsPerCall) {
        return { allowed: false, code: "advance_limit_exceeded", message: `requestedSeconds ${requested} exceeds the per-call limit of ${this.limits.maxAdvanceSecondsPerCall} s.` };
      }
      const remaining = this.limits.maxTotalAdvanceSeconds - this.advancedSimSeconds;
      if (requested > remaining) {
        return { allowed: false, code: "advance_limit_exceeded", message: `Only ${Math.max(0, remaining)} simulated seconds of advancement remain for this run.` };
      }
    }
    return { allowed: true };
  }
}
