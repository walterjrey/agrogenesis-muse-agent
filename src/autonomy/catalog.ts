import type { AvailableAction, AvailableActions } from "../contracts/actions.js";

/**
 * Agent-layer compaction of the simulator's action catalog. Nothing is invented and nothing is re-validated here:
 * eligibility, estimates and parameter schemas are the simulator's own. The recurring (per-cycle) view lists each
 * action type once with its targets and a one-line parameter hint; `describeAction` returns the full simulator
 * detail (JSON Schema, preconditions, constraints, equipment, complete eligibility issues) on demand.
 */

type JsonSchema = Record<string, unknown>;

function describeSchemaNode(node: unknown): string {
  if (!node || typeof node !== "object") return "any";
  const n = node as JsonSchema;
  if (Array.isArray(n.enum)) return `enum(${n.enum.join("|")})`;
  const variants = (n.anyOf ?? n.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) return variants.map(describeSchemaNode).join("|");
  const type = Array.isArray(n.type) ? n.type.join("|") : (n.type as string | undefined) ?? "any";
  if (type === "array") return `array<${describeSchemaNode(n.items)}>`;
  if (type === "number" || type === "integer") {
    const bounds: string[] = [];
    if (typeof n.minimum === "number") bounds.push(`>=${n.minimum}`);
    if (typeof n.exclusiveMinimum === "number") bounds.push(`>${n.exclusiveMinimum}`);
    if (typeof n.maximum === "number") bounds.push(`<=${n.maximum}`);
    if (typeof n.exclusiveMaximum === "number") bounds.push(`<${n.exclusiveMaximum}`);
    return bounds.length ? `${type}(${bounds.join(",")})` : type;
  }
  return type;
}

/** One entry per parameter, e.g. `volumeM3*:number(>0,<=1000)`; `*` marks required parameters. */
export function parameterHints(schema: JsonSchema): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).map(([name, node]) => {
    const fallback = "default" in node ? `=${JSON.stringify(node.default)}` : "";
    return `${name}${required.has(name) ? "*" : ""}:${describeSchemaNode(node)}${fallback}`;
  });
}

const RESOURCE_LABELS: Array<[keyof AvailableAction["estimate"]["resources"], string]> = [
  ["credits", "credits"],
  ["waterM3", "m3 water"],
  ["feedKg", "kg feed"],
  ["energyWh", "Wh energy"],
  ["fuelL", "L fuel"],
  ["seedKg", "kg seed"],
];

export function estimateText(estimate: AvailableAction["estimate"]): string {
  const parts = RESOURCE_LABELS.flatMap(([key, label]) => {
    const value = estimate.resources[key];
    return typeof value === "number" && value !== 0 ? [`${value} ${label}`] : [];
  });
  parts.push(`${estimate.durationS} s`);
  return parts.join(", ");
}

const firstSentence = (text: string, max = 160): string => {
  const sentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
};

export interface CompactActionType {
  type: string;
  label: string;
  category: AvailableAction["category"];
  summary: string;
  asynchronous: boolean;
  approvalRequired: boolean;
  params: string[];
  /** Present when every target shares the estimate; otherwise each target carries its own. */
  estimate?: string;
  eligibleTargets: Array<{ target: string | null; estimate?: string }>;
  ineligibleTargets: Array<{ target: string | null; why: string }>;
}

export interface CompactCatalog {
  revision: number;
  simTimeS: number;
  eligibleActionTypes: number;
  eligibleOptions: number;
  actions: CompactActionType[];
  note: string;
}

export function compactCatalog(catalog: AvailableActions): CompactCatalog {
  const groups = new Map<string, AvailableAction[]>();
  for (const action of catalog.actions) groups.set(action.type, [...(groups.get(action.type) ?? []), action]);

  const actions: CompactActionType[] = [...groups.values()].map((entries) => {
    const head = entries[0]!;
    const estimates = new Set(entries.map((e) => estimateText(e.estimate)));
    const uniform = estimates.size === 1;
    const targetOf = (e: AvailableAction): string | null => e.target?.id ?? null;
    return {
      type: head.type,
      label: head.label,
      category: head.category,
      summary: firstSentence(head.description),
      asynchronous: head.asynchronous,
      approvalRequired: head.approvalRequired,
      params: parameterHints(head.parametersSchema),
      ...(uniform ? { estimate: [...estimates][0]! } : {}),
      eligibleTargets: entries.filter((e) => e.eligibility.eligible).map((e) => ({ target: targetOf(e), ...(uniform ? {} : { estimate: estimateText(e.estimate) }) })),
      ineligibleTargets: entries.filter((e) => !e.eligibility.eligible).map((e) => ({ target: targetOf(e), why: e.eligibility.issues.map((i) => i.code).join(",") || "ineligible" })),
    };
  });

  return {
    revision: catalog.revision,
    simTimeS: catalog.simTimeS,
    eligibleActionTypes: actions.filter((a) => a.eligibleTargets.length > 0).length,
    eligibleOptions: actions.reduce((sum, a) => sum + a.eligibleTargets.length, 0),
    actions,
    note: "Compact view of the simulator's catalog. Call describe_action for the full parameter schema, preconditions and eligibility details of one type. Only the simulator validates actions.",
  };
}

export interface DigestActionType {
  type: string;
  category: AvailableAction["category"];
  asynchronous: boolean;
  params: string[];
  /** Eligible targets grouped by identical simulator estimate. */
  options: Array<{ targets: Array<string | null>; estimate: string }>;
  /** Target ids that are not eligible right now; the reasons come from describe_action. */
  notEligible?: Array<string | null>;
}

export interface DigestCatalog {
  revision: number;
  simTimeS: number;
  eligibleActionTypes: number;
  eligibleOptions: number;
  actions: DigestActionType[];
  /** Action types the simulator lists but that have no eligible target at this revision. */
  typesWithoutEligibleTarget: string[];
  note: string;
}

/**
 * The recurring, smallest view: only action types with at least one eligible target, targets grouped by identical
 * estimate, no prose. Everything shown is the simulator's own eligibility and estimate; ineligibility reasons,
 * summaries and full schemas stay behind describe_action. Nothing is invented.
 */
export function digestCatalog(catalog: AvailableActions): DigestCatalog {
  const groups = new Map<string, AvailableAction[]>();
  for (const action of catalog.actions) groups.set(action.type, [...(groups.get(action.type) ?? []), action]);
  const actions: DigestActionType[] = [];
  const without: string[] = [];
  for (const entries of groups.values()) {
    const head = entries[0]!;
    const eligible = entries.filter((e) => e.eligibility.eligible);
    if (eligible.length === 0) {
      without.push(head.type);
      continue;
    }
    const byEstimate = new Map<string, Array<string | null>>();
    for (const e of eligible) {
      const key = estimateText(e.estimate);
      byEstimate.set(key, [...(byEstimate.get(key) ?? []), e.target?.id ?? null]);
    }
    const notEligible = entries.filter((e) => !e.eligibility.eligible).map((e) => e.target?.id ?? null);
    actions.push({
      type: head.type,
      category: head.category,
      asynchronous: head.asynchronous,
      params: parameterHints(head.parametersSchema),
      options: [...byEstimate.entries()].map(([estimate, targets]) => ({ targets, estimate })),
      ...(notEligible.length ? { notEligible } : {}),
    });
  }
  return {
    revision: catalog.revision,
    simTimeS: catalog.simTimeS,
    eligibleActionTypes: actions.length,
    eligibleOptions: actions.reduce((sum, a) => sum + a.options.reduce((n, o) => n + o.targets.length, 0), 0),
    actions,
    typesWithoutEligibleTarget: without,
    note: "Digest of eligible actions only (* = required param). describe_action(type) gives the full schema, preconditions and why a target is not eligible. Only the simulator validates actions.",
  };
}

export interface ActionDescription {
  revision: number;
  type: string;
  label: string;
  category: string;
  description: string;
  asynchronous: boolean;
  approvalRequired: boolean;
  cancellation: string;
  preconditions: string[];
  constraints: string[];
  requiredEquipment: string[];
  /** Distinct parameter schemas with the targets they apply to (usually one). */
  parameterSchemas: Array<{ appliesToTargets: Array<string | null>; schema: JsonSchema }>;
  targets: Array<{ target: string | null; label: string | null; eligible: boolean; issues: Array<{ code: string; detail: string }>; estimate: AvailableAction["estimate"] }>;
}

export function describeAction(catalog: AvailableActions, type: string): ActionDescription | null {
  const entries = catalog.actions.filter((a) => a.type === type);
  const head = entries[0];
  if (!head) return null;
  const schemas = new Map<string, { appliesToTargets: Array<string | null>; schema: JsonSchema }>();
  for (const entry of entries) {
    const { $schema: _ignored, ...schema } = entry.parametersSchema;
    void _ignored;
    const key = JSON.stringify(schema);
    const slot = schemas.get(key) ?? { appliesToTargets: [], schema };
    slot.appliesToTargets.push(entry.target?.id ?? null);
    schemas.set(key, slot);
  }
  return {
    revision: catalog.revision,
    type: head.type,
    label: head.label,
    category: head.category,
    description: head.description,
    asynchronous: head.asynchronous,
    approvalRequired: head.approvalRequired,
    cancellation: head.cancellation,
    preconditions: head.preconditions,
    constraints: head.constraints,
    requiredEquipment: head.requiredEquipment,
    parameterSchemas: [...schemas.values()],
    targets: entries.map((e) => ({ target: e.target?.id ?? null, label: e.target?.label ?? null, eligible: e.eligibility.eligible, issues: e.eligibility.issues.map((i) => ({ code: i.code, detail: i.detail })), estimate: e.estimate })),
  };
}
