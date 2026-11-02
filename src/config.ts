/**
 * Plugin configuration parsing and validation.
 */

export interface BetterSubagentsConfig {
  /** How long (in seconds) a failed model remains in cooldown. Defaults to 300 (5 minutes). */
  readonly cooldownSeconds: number;
  /** Fallback model chains per subagent name (e.g. "explore"). */
  readonly agents: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_COOLDOWN_SECONDS = 300;

export function parseConfig(options?: Readonly<Record<string, unknown>>): BetterSubagentsConfig {
  if (!options || typeof options !== "object") {
    return { cooldownSeconds: DEFAULT_COOLDOWN_SECONDS, agents: {} };
  }

  const cooldown = typeof options.cooldownSeconds === "number" && Number.isFinite(options.cooldownSeconds) && options.cooldownSeconds > 0
    ? Math.floor(options.cooldownSeconds)
    : DEFAULT_COOLDOWN_SECONDS;

  const rawAgents = options.agents;
  const agents: Record<string, string[]> = {};

  if (rawAgents && typeof rawAgents === "object" && !Array.isArray(rawAgents)) {
    for (const [agentName, chain] of Object.entries(rawAgents)) {
      if (Array.isArray(chain)) {
        const validModels = chain
          .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
          .map((m) => m.trim());
        if (validModels.length > 0) {
          agents[agentName.trim()] = validModels;
        }
      }
    }
  }

  return {
    cooldownSeconds: cooldown,
    agents,
  };
}
