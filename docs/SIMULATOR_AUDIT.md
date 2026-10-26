# Simulator audit (pre-hackathon AgroGenesis)

Audited read-only at tag `pre-hackathon-2026` (paths relative to the `agrogenesis` repo). Nothing in the simulator was modified.

| Area | Status | Location |
| --- | --- | --- |
| Simulation engine | Exists (pure TypeScript, runs in Node) | `src/simulation/engine/simulation.ts` (`Simulation`, `advance`, `fastForward`), `src/simulation/index.ts` (`createSimulation`) |
| Simulation clock | Exists, fixed tick | `src/simulation/core/clock.ts` (`SimulationClock`); time = `tickCount * FIXED_STEP_SECONDS` |
| Persistence | Exists (PostgreSQL, JSONB snapshots, revisions) | `db/migrations/0001..0003`, `src/server/gameRepository.ts` |
| Game ids / ownership | UUID ids; every query scoped by `owner_id` | `src/app/api/games/route.ts`, `src/server/gameRepository.ts` |
| Ground truth vs. knowledge | Separated: truth lives in `Simulation.environment/ecosystem`, agent knowledge in `ObservationState` | `src/simulation/environment/observation.ts`, `observationView.ts` (`queryAgentObservations`), `src/simulation/analysis/agentFeedback.ts` |
| Drone / rover observations | Exists | `src/simulation/robotics/` (`ObservationReport`), `src/simulation/soil/knowledge.ts` |
| Action registry | Exists | `src/simulation/management/registry.ts` (`ACTION_DEFINITIONS`, zod `PARAM_SCHEMAS`) |
| Validators + execution pipeline | Exists; async via schedule/start/complete | `src/simulation/management/manager.ts` (`ManagementSystem.catalog/preview/submit/propose/cancel/get/timeline`) |
| Event / action history | Exists internally (no HTTP) | `src/simulation/engine/events.ts`, `ActionRecord` + timeline in `manager.ts` |
| Manual / Muse / Hybrid | Manual works; Muse/Hybrid disabled (`AI_AGENT_CONNECTED = false`, `POST /api/games` rejects non-manual) | `manager.ts:36`, `src/app/api/games/route.ts` |
| Comparison | Exists | `POST /api/games/:id/fork`, `/api/comparisons`, `src/simulation/analysis/` |

## Existing HTTP API

All routes require the single administrator's session cookie (`authenticatedAdministrator()`); mutating routes also require a trusted `Origin`.

`GET/POST /api/games`, `GET/PUT/DELETE /api/games/:id`, `POST /api/games/:id/fork`, `POST /api/comparisons`, `GET /api/comparisons/:id`, Auth.js under `/api/auth/*`.

## Gaps for an external agent

1. **No server-to-server auth.** Only a browser cookie session obtained by username/password; no scoped tokens.
2. **`GET /api/games/:id` returns the full serialized simulation state** (ground truth). Using it would break partial observability.
3. **The simulation is advanced and saved by the browser** (`PUT` of a snapshot). No server-side tick loop; no endpoint to advance time.
4. **No HTTP surface for the action catalog, preview, submit, cancel or timeline**, although `ManagementSystem` already implements them with agent-safe return types.
5. No overview, field-observation or event-history endpoints.

## Safe integration points

`ManagementSystem` (`catalog`, `preview`, `submit` with `origin: "ai"`, `get`, `timeline`) and `queryAgentObservations` already return only agent-visible data and are the intended seam. Required changes are in [SIMULATOR_INTEGRATION.md](SIMULATOR_INTEGRATION.md).
