import { describe, expect, it } from "vitest";
import { requiresDecision } from "../../src/autonomy/eventClassification.js";

const ev = (kind: string, data: Record<string, unknown> = {}) => ({ kind, data }) as Parameters<typeof requiresDecision>[0];

describe("event classification", () => {
  it("wakes the model for decision events", () => {
    for (const kind of ["crop_ready", "action_completed", "action_failed", "action_cancelled", "mode_changed", "weather_alert", "equipment_status_changed"]) {
      expect(requiresDecision(ev(kind)), kind).toBe(true);
    }
    expect(requiresDecision(ev("field_attention", { level: 2, status: "active" }))).toBe(true);
    expect(requiresDecision(ev("field_attention", { level: 3, status: "escalated" }))).toBe(true);
  });

  it("keeps informational events from forcing a model call", () => {
    for (const kind of ["action_started", "observation_delivered"]) expect(requiresDecision(ev(kind)), kind).toBe(false);
    expect(requiresDecision(ev("field_attention", { level: 1, status: "active" }))).toBe(false);
    expect(requiresDecision(ev("field_attention", { level: 3, status: "resolved" }))).toBe(false);
  });
});
