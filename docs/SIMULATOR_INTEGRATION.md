# Simulator integration: contract and required simulator changes

The agent talks to the simulator only through a narrow server-to-server HTTP API. The typed, runtime-validated contracts live in `src/contracts/`; `src/simulator/client.ts` implements the client. **Phase 1 (read-only) endpoints now exist in the AgroGenesis repo** (`docs/AGENT_API.md` there): `games`, `overview`, `fields`, `actions`, verified live with `npm run integration:real` (4 GET requests, 0 mutating). Tokens are provisioned by an administrator on the server with `npm run agent:token`, not from the UI. Execute and time-advance endpoints are still a proposal (see `docs/SIMULATION_AUTHORITY.md` there); the section below describes the original proposal.

## Endpoints (`/api/agent/v1`)

| Method + path | Purpose | Contract |
| --- | --- | --- |
| `GET /games` | Games the token may access | `AuthorizedGames` |
| `GET /games/:id/overview` | Day, weather, resources, equipment, status, finance (if authorized) | `FarmOverview` |
| `GET /games/:id/fields` | Observed field state with age, confidence, uncertainty, missing data | `FieldObservations` |
| `GET /games/:id/actions` | Eligible actions with parameter schema, preconditions, estimates | `AvailableActions` |
| `POST /games/:id/actions` | Execute (or `dryRun`) an action; async | `ExecuteActionRequest` / `ExecuteActionResponse` |
| `GET /games/:id/actions/:actionId` | Poll an action | `ActionStatusResponse` |
| `GET /games/:id/events?cursor=` | Agent-visible events since a cursor | `EventsResponse` |
| `POST /games/:id/clock/advance` | *Request* time progression | `AdvanceRequest` / `AdvanceResponse` |

## Required simulator changes (smallest set)

1. **Scoped agent tokens**: random 256-bit bearer token, stored only as a hash, bound to one owner + game ids + scopes (`observe`, `act`, `advance`), with expiry and revocation. Issued by the administrator from the existing authenticated UI; never the admin password. Agent routes use this instead of the cookie and skip the browser `Origin` check; the existing routes remain unchanged.
2. **Ownership**: resolve the game via the token's owner (`getGame(id, ownerId)`), exactly like today; unauthorized ids return 404.
3. **Server-side loading of a game** into a `Simulation` from its snapshot (the engine already runs in Node), then adapters:
   - overview / fields: map `ObservationState` via `queryAgentObservations`. Do not serialize `environment`, `ecosystem` or the snapshot.
   - actions: `ManagementSystem.catalog()` + `preview()`; derive `parametersSchema` from `PARAM_SCHEMAS` (`z.toJSONSchema`).
   - execute: `ManagementSystem.submit({ origin: "ai", actorId: <token id>, ... })`. This is the single authoritative validator; the agent does not duplicate it. Enforce the existing hybrid-mode `approvalRequired` policy. Idempotency key stored per game; `expectedRevision` checked against the game revision.
4. **Clock**: `advance` runs the real `Simulation.advance` for at most `min(requested, per-call cap, remaining daily budget)`, stops early on the requested events, then persists a new snapshot revision. The agent can never set time directly. Like `execute`, `advance` requires both `idempotencyKey` and `expectedRevision` (confirmed against the implemented `AdvanceRequestSchema`); `AdvanceRequest` in this repo's contracts was initially missing `expectedRevision` and has been corrected to match.
5. **Enable `muse_ai`/`hybrid` creation** only after the above (`AI_AGENT_CONNECTED`), keeping manual mode behaviour untouched.
6. Rate limits and audit logging on agent routes; `Cache-Control: no-store`.

## Security rules enforced agent-side

- Responses are parsed with strict zod schemas; unknown fields (e.g. leaked truth) cause a `contract` error instead of reaching the model.
- Bearer token only in the `Authorization` header, redacted from logs; redirects disabled; request timeouts.
- `executeAction` defaults to `dryRun: true` and always sends an idempotency key.
- The read-only integration flow never calls `executeAction` or `advance`.
- Meta API key is read from `MODEL_API_KEY` on the server only.
