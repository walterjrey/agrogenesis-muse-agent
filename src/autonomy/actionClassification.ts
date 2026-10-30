/**
 * Classifies simulator action `type` values submitted through the generic `execute_action` tool so the agent's own
 * local budget bookkeeping can tell a read-only observation mission apart from a real farm-mutating action, instead
 * of treating every `execute_action` call identically.
 *
 * This is NOT the safety boundary: the simulator (agrogenesis) is the only authority on what an action actually does
 * and whether it is allowed; this list only affects which of the agent's own budgets (`maxInspections` vs
 * `maxMutations`) a submission counts against. Classification was decided by reading the simulator's own action
 * definitions and executors (agrogenesis/src/simulation/management/registry.ts and manager.ts), not by reusing the
 * `approvalRequired`/`category` flags alone:
 *
 * - `inspectField`: registry.ts documents it explicitly as "Adds noisy observations of the whole field to agent
 *   knowledge; does not change the ecosystem." manager.ts's executor only records an observation; no field/crop/
 *   inventory/credit mutation occurs.
 * - `surveyField`, `inspectLocation`, `sampleSoil`, `inspectPestPressure`: robotics missions that fly/drive a robot
 *   to deliver sensor observations ("delivers sensor observations", "measures soil moisture and fertility",
 *   "scouts local pest pressure", "records what its sensors can see"). They consume real robot battery/time (and,
 *   for `inspectField`, credits) but never touch field, crop, inventory or credit-spend state.
 *
 * Deliberately excluded (left under the mutation budget, unchanged from prior behavior): `returnToBase` and
 * `rechargeRobot` are robot logistics, not observation-gathering, and were out of scope for this change.
 */
export const INSPECTION_ACTION_TYPES: ReadonlySet<string> = new Set(["inspectField", "surveyField", "inspectLocation", "sampleSoil", "inspectPestPressure"]);

/** True only for the reviewed, allow-listed observation-only action types above. Unknown/future types default to `false` (mutation budget) until explicitly reviewed and added here. */
export function isInspectionActionType(type: unknown): boolean {
  return typeof type === "string" && INSPECTION_ACTION_TYPES.has(type);
}
