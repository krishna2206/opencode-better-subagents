/**
 * Subagent execution wrapper implementing candidate fallback,
 * circuit breaking, and cleanup of failed child sessions.
 */

import type { BetterSubagentsConfig } from "./config.js";
import type { CircuitBreaker } from "./circuit-breaker.js";

export interface SubagentToolInput {
  agent: string;
  prompt: string;
  description: string;
  model?: string;
  sessionID?: string;
  background?: boolean;
}

export function isCancelledError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("subagent cancelled") || msg.includes("aborterror") || msg.includes("user cancelled");
}

export function extractFailedSessionID(error: unknown): string | null {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/sessionID:\s*([a-zA-Z0-9_-]+)/i);
  return match ? match[1]! : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createSubagentExecutor(
  originalExecute: (input: any, context: any) => Promise<any>,
  config: BetterSubagentsConfig,
  circuitBreaker: CircuitBreaker,
  removeSession?: (sessionID: string) => Promise<void>,
) {
  return async function executeWithFallback(input: SubagentToolInput, context: any): Promise<any> {
    const rawAgent = input.agent?.trim();

    // 1. If agent is not configured with a fallback chain, pass through directly
    if (!rawAgent || !config.agents[rawAgent] || config.agents[rawAgent]!.length === 0) {
      return await originalExecute(input, context);
    }

    // 2. If caller explicitly requested a specific model, do not override
    if (input.model && typeof input.model === "string" && input.model.trim().length > 0) {
      return await originalExecute(input, context);
    }

    // 3. If caller is continuing an existing session, do not override its model
    if (input.sessionID && typeof input.sessionID === "string" && input.sessionID.trim().length > 0) {
      return await originalExecute(input, context);
    }

    // 4. Resolve candidate chain and filter out cooled-down models
    const chain = config.agents[rawAgent]!;
    const candidates = circuitBreaker.pickCandidates(chain);

    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const candidateModel = candidates[i]!;

      // Check for caller-side abort before launching next candidate
      if (context?.signal?.aborted) {
        throw new Error("Subagent execution aborted");
      }

      try {
        const result = await originalExecute({ ...input, model: candidateModel }, context);
        // Succeeded on this model: clear any prior cooldown
        circuitBreaker.markSuccess(candidateModel);
        return result;
      } catch (err) {
        lastError = err;

        // Never retry if cancelled by user or caller signal
        if (context?.signal?.aborted || isCancelledError(err)) {
          throw err;
        }

        // Put failed model into cooldown
        circuitBreaker.markFailure(candidateModel, config.cooldownSeconds * 1000);

        // Clean up failed child session if one was created
        const failedChildSession = extractFailedSessionID(err);
        if (failedChildSession && removeSession) {
          void removeSession(failedChildSession).catch(() => {});
        }

        // If there are more candidates to try, log and continue
        if (i + 1 < candidates.length) {
          const nextCandidate = candidates[i + 1]!;
          console.warn(
            `[better-subagents] Subagent '${rawAgent}' failed on model ${candidateModel} (${getErrorMessage(err)}). Retrying on ${nextCandidate}...`,
          );
          continue;
        }
      }
    }

    throw lastError;
  };
}
