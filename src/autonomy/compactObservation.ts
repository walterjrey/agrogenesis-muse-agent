import type { FieldObservations } from "../contracts/fieldObservations.js";

const round = (n: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/**
 * Recurring-context form of the field observations. It drops only redundancy (labels the id already carries, the
 * per-measurement age derivable from `at` and the snapshot time, units repeated per measurement, a coverage of 1).
 * Values, uncertainty, observation timestamps, freshness, confidence and the list of unobserved quantities are kept.
 */
export function compactFields(observations: FieldObservations) {
  const units: Record<string, string> = {};
  const fields = observations.fields.map((f) => {
    const measurements: Record<string, Record<string, unknown>> = {};
    for (const [name, m] of Object.entries(f.measurements)) {
      units[name] ??= m.unit;
      measurements[name] = {
        v: round(m.value, 4),
        ...(m.uncertainty !== null ? { sd: round(m.uncertainty, 4) } : {}),
        at: round(m.observedAtSimTimeS, 2),
        fresh: m.freshness,
        c: round(m.confidence, 2),
        sensor: m.sensorType,
        ...(m.coverage < 1 ? { cov: round(m.coverage, 2) } : {}),
      };
    }
    return {
      id: f.fieldId,
      ha: round(f.areaHa, 2),
      ...(f.knownCrop ? { crop: f.knownCrop } : {}),
      ...(f.knownGrowthStage ? { stage: f.knownGrowthStage } : {}),
      lastObservedAtS: f.lastObservedAtSimTimeS,
      ...(f.activeOperationActionId ? { activeOp: f.activeOperationActionId } : {}),
      ...(f.attention && f.attention.length > 0 ? { warn: f.attention.map((a) => ({ cat: a.category, lvl: a.level, since: round(a.sinceSimTimeS, 2) })) } : {}),
      m: measurements,
      unobserved: f.missing,
    };
  });
  const first = fields[0]?.unobserved ?? [];
  const sameMissing = fields.length > 0 && fields.every((f) => f.unobserved.length === first.length && f.unobserved.every((x, i) => x === first[i]));
  return {
    revision: observations.revision,
    simTimeS: observations.simTimeS,
    note: "No sensor reports crop identity or growth stage. Measurements: v=value, sd=uncertainty (1 sigma), at=observation sim time, fresh=freshness, c=confidence. Age = simTimeS - at.",
    units,
    ...(sameMissing && first.length > 0 ? { unobservedInEveryField: first } : {}),
    fields: sameMissing ? fields.map((f) => ({ id: f.id, ha: f.ha, ...(f.crop ? { crop: f.crop } : {}), ...(f.stage ? { stage: f.stage } : {}), lastObservedAtS: f.lastObservedAtS, ...(f.activeOp ? { activeOp: f.activeOp } : {}), ...(f.warn ? { warn: f.warn } : {}), m: f.m })) : fields,
  };
}
