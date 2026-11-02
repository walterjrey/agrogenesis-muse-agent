import type { GameEvent } from "../contracts/time.js";

/**
 * Single source of truth for which simulator events end an accelerated wait (and so wake the model) and which are
 * only informational context for the next decision.
 *
 * Decision-requiring: an operation finished, failed or was cancelled; the control mode changed; a weather alert or
 * equipment status change; a crop became harvest-eligible; a field's crop-stress or pest alert started or escalated
 * to level 2 or higher.
 * Informational: an operation started, an observation was delivered, a level-1 field warning, or any warning that resolved.
 * Informational events are still delivered in the event feed, so the next decision sees them; they just do not force one.
 */
export function requiresDecision(event: Pick<GameEvent, "kind" | "data">): boolean {
  switch (event.kind) {
    case "action_completed":
    case "action_failed":
    case "action_cancelled":
    case "mode_changed":
    case "weather_alert":
    case "equipment_status_changed":
    case "crop_ready":
      return true;
    case "field_attention": {
      const level = typeof event.data.level === "number" ? event.data.level : 2;
      return event.data.status !== "resolved" && level >= 2;
    }
    case "action_started":
    case "observation_delivered":
      return false;
  }
}
