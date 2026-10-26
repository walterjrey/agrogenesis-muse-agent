import type { Logger } from "../logging/logger.js";
import type { SimulatorClient } from "./client.js";

export interface IntegrationReport {
  gameId: string;
  gameName: string;
  simDay: number;
  simTimeS: number;
  revision: number;
  fieldCount: number;
  availableActionCount: number;
  eligibleActionCount: number;
  eligibleActionTypes: string[];
  mutatingCalls: 0;
}

/**
 * Read-only end-to-end check: authenticate (token), select an authorized game, read the overview,
 * field observations and eligible actions, validating each response against the contracts.
 * Deliberately never calls executeAction or advance.
 */
export async function runReadOnlyIntegration(client: SimulatorClient, logger: Logger, preferredGameId?: string): Promise<IntegrationReport> {
  const { games } = await client.listGames();
  logger.log("info", "integration.games_listed", { count: games.length });

  const observable = games.filter((g) => g.scopes.includes("observe"));
  const game = preferredGameId ? observable.find((g) => g.gameId === preferredGameId) : observable.length === 1 ? observable[0] : undefined;
  if (!game) {
    const reason = preferredGameId ? "Configured game is not authorized for this token." : "Set SIMULATOR_GAME_ID: the token does not authorize exactly one game.";
    logger.log("error", "integration.game_selection_failed", { reason, authorized: observable.length });
    throw new Error(reason);
  }

  const overview = await client.getFarmOverview(game.gameId);
  const fields = await client.getFieldObservations(game.gameId);
  const actions = await client.getAvailableActions(game.gameId);
  const eligible = actions.actions.filter((a) => a.eligibility.eligible);

  const report: IntegrationReport = {
    gameId: game.gameId,
    gameName: game.name,
    simDay: overview.clock.simDay,
    simTimeS: overview.clock.simTimeS,
    revision: overview.revision,
    fieldCount: fields.fields.length,
    availableActionCount: actions.actions.length,
    eligibleActionCount: eligible.length,
    eligibleActionTypes: [...new Set(eligible.map((a) => a.type))].sort(),
    mutatingCalls: 0,
  };
  logger.log("info", "integration.completed", { ...report });
  return report;
}
