/**
 * Subagent execution wrapper implementing catalog filtering, candidate fallback,
 * circuit breaking, background run tracking, and cleanup of failed child sessions.
 */

import { Model } from "@opencode/plugin";
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

export interface CatalogModelEntry {
  readonly id: string;
  readonly providerID: string;
  readonly enabled?: boolean;
  readonly type?: string;
  readonly variants?: ReadonlyArray<{ readonly id: string }>;
}

export interface SubagentExecutorDeps {
  readonly removeSession?: (sessionID: string) => Promise<void>;
  readonly listModels?: () => Promise<ReadonlyArray<CatalogModelEntry>>;
  readonly onRunningSession?: (sessionID: string, model: string) => void;
}

const NON_RETRYABLE_PATTERNS = [
  "subagent cancelled",
  "aborterror",
  "user cancelled",
  "subagent denied:",
  "subagent depth limit reached",
  "parent session not found:",
  "unknown agent:",
  "cannot run as a subagent",
  "subagent session not found:",
  "is not a child of the current session",
];

export function isCancelledError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("subagent cancelled") || msg.includes("aborterror") || msg.includes("user cancelled");
}

/**
 * Returns true when an error comes from cancellation, permissions, depth limits,
 * or invalid caller arguments rather than the selected model/provider.
 * Retrying another model on these errors would fail identically and poison cooldowns.
 */
export function isNonRetryableSubagentError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return NON_RETRYABLE_PATTERNS.some((pattern) => msg.includes(pattern));
}

export function extractFailedSessionID(error: unknown): string | null {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/sessionID:\s*([a-zA-Z0-9_-]+)/i);
  return match ? match[1]! : null;
}

/**
 * Filters a candidate chain against OpenCode's active chat model catalog so
 * disabled providers or missing variants are skipped upfront without wasted retries.
 */
export function filterCatalogCandidates(
  chain: readonly string[],
  catalog: ReadonlyArray<CatalogModelEntry>,
): string[] {
  return chain.filter((candidate) => {
    let ref: Model.Ref;
    try {
      ref = Model.Ref.parse(candidate);
    } catch {
      return false;
    }

    const match = catalog.find(
      (m) =>
        m.providerID === ref.providerID &&
        m.id === ref.id &&
        m.enabled !== false &&
        (m.type === undefined || m.type === "chat"),
    );
    if (!match) return false;

    if (ref.variant !== undefined) {
      const variants = match.variants ?? [];
      if (!variants.some((v) => v.id === ref.variant)) return false;
    }

    return true;
  });
}

function isRunningResult(input: SubagentToolInput, result: any): boolean {
  if (input.background === true) return true;
  if (result?.output?.status === "running") return true;
  if (result?.metadata?.status === "running") return true;
  return false;
}

function extractRunningSessionID(result: any): string | null {
  const id = result?.output?.sessionID ?? result?.metadata?.sessionID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createSubagentExecutor(
  originalExecute: (input: any, context: any) => Promise<any>,
  config: BetterSubagentsConfig,
  circuitBreaker: CircuitBreaker,
  deps: SubagentExecutorDeps = {},
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

    // 4. Filter configured chain against currently enabled catalog models when available
    const configuredChain = config.agents[rawAgent]!;
    let availableChain: readonly string[] = configuredChain;

    if (deps.listModels) {
      let catalog: ReadonlyArray<CatalogModelEntry> | undefined;
      try {
        catalog = await deps.listModels();
      } catch {
        // Catalog query failed transiently: fall back to the configured list
      }
      if (catalog !== undefined) {
        const filtered = filterCatalogCandidates(configuredChain, catalog);
        if (filtered.length === 0) {
          throw new Error(
            `No configured fallback model for subagent '${rawAgent}' is currently available in OpenCode catalog (${configuredChain.join(", ")})`,
          );
        }
        availableChain = filtered;
      }
    }

    // 5. Filter out cooled-down models (falls back to availableChain if all are cooling down)
    const candidates = circuitBreaker.pickCandidates(availableChain);

    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const candidateModel = candidates[i]!;

      if (context?.signal?.aborted) {
        throw new Error("Subagent execution aborted");
      }

      try {
        const result = await originalExecute({ ...input, model: candidateModel }, context);

        // Background or mid-run backgrounded subagents return immediately with status="running"
        // before the LLM call completes: track completion asynchronously via session events
        // instead of clearing cooldown prematurely.
        if (isRunningResult(input, result)) {
          const runningSessionID = extractRunningSessionID(result);
          if (runningSessionID && deps.onRunningSession) {
            deps.onRunningSession(runningSessionID, candidateModel);
          }
          return result;
        }

        circuitBreaker.markSuccess(candidateModel);
        return result;
      } catch (err) {
        lastError = err;

        // Never retry or penalize models on user abort, permission denial, depth limit, or caller validation errors
        if (context?.signal?.aborted || isNonRetryableSubagentError(err)) {
          throw err;
        }

        // Put failed model into cooldown
        circuitBreaker.markFailure(candidateModel, config.cooldownSeconds * 1000);

        // Clean up failed child session if one was created
        const failedChildSession = extractFailedSessionID(err);
        if (failedChildSession && deps.removeSession) {
          void deps.removeSession(failedChildSession).catch(() => {});
        }

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
