/**
 * In-memory circuit breaker for subagent models.
 * Tracks temporary cooldowns when a model fails (quota exhausted, rate limit, provider error).
 */

export class CircuitBreaker {
  private readonly cooldowns = new Map<string, number>();

  /**
   * Check whether a model is currently in cooldown.
   */
  isCoolingDown(model: string, now = Date.now()): boolean {
    const until = this.cooldowns.get(model);
    if (until === undefined) return false;
    if (until <= now) {
      this.cooldowns.delete(model);
      return false;
    }
    return true;
  }

  /**
   * Mark a model as failed, putting it in cooldown until now + cooldownDurationMs.
   */
  markFailure(model: string, cooldownDurationMs: number, now = Date.now()): void {
    this.cooldowns.set(model, now + cooldownDurationMs);
  }

  /**
   * Clear cooldown for a model that succeeded.
   */
  markSuccess(model: string): void {
    this.cooldowns.delete(model);
  }

  /**
   * Clear all cooldowns.
   */
  clear(): void {
    this.cooldowns.clear();
  }

  /**
   * Return candidate models that are not in cooldown.
   * If ALL candidates are in cooldown, returns all candidates so execution is not completely blocked.
   */
  pickCandidates(candidates: readonly string[], now = Date.now()): string[] {
    const active = candidates.filter((m) => !this.isCoolingDown(m, now));
    return active.length > 0 ? active : [...candidates];
  }
}
