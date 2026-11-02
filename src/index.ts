/**
 * OpenCode Better Subagents plugin.
 * Wraps the built-in subagent tool to support ordered model fallback chains,
 * catalog filtering, circuit breaking on failures (sync and background),
 * and automatic cleanup of failed child sessions.
 */

import { Plugin } from "@opencode/plugin";
import { parseConfig } from "./config.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { createSubagentExecutor } from "./fallback.js";

export default Plugin.define({
  id: "opencode-better-subagents",
  setup: async (ctx) => {
    const config = parseConfig(ctx.options);

    if (Object.keys(config.agents).length === 0) {
      return;
    }

    const circuitBreaker = new CircuitBreaker();
    const pendingSessions = new Map<string, string>();
    const stop = new AbortController();

    // Observe completion/failure of backgrounded subagent sessions so their model
    // cooldowns update accurately once the asynchronous run actually finishes.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.deleted",
          ],
          signal: stop.signal,
        })) {
          const sessionID = event.data.sessionID;
          const model = pendingSessions.get(sessionID);
          if (!model) continue;

          pendingSessions.delete(sessionID);

          if (event.type === "session.execution.succeeded") {
            circuitBreaker.markSuccess(model);
          } else if (event.type === "session.execution.failed") {
            circuitBreaker.markFailure(model, config.cooldownSeconds * 1000);
          }
        }
      } catch {
        // Stream ended or aborted on plugin reload/shutdown
      }
    })();

    await ctx.tool.transform((tools) => {
      tools.update("subagent", (tool) => {
        const originalExecute = tool.execute;
        tool.execute = createSubagentExecutor(originalExecute, config, circuitBreaker, {
          listModels: async () => {
            const res = await ctx.model.list({ types: ["chat"] });
            return res.data;
          },
          removeSession: async (sessionID) => {
            try {
              await ctx.session.remove({ sessionID });
            } catch {
              // Ignore cleanup errors on already deleted sessions
            }
          },
          onRunningSession: (sessionID, model) => {
            pendingSessions.set(sessionID, model);
          },
        });
      });
    });

    return () => {
      stop.abort();
      pendingSessions.clear();
    };
  },
});
