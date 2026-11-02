/**
 * OpenCode Better Subagents plugin.
 * Wraps the built-in subagent tool to support ordered model fallback chains,
 * circuit breaking on failures, and automatic cleanup of failed child sessions.
 */

import { Plugin } from "@opencode/plugin";
import { parseConfig } from "./config.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { createSubagentExecutor } from "./fallback.js";

export default Plugin.define({
  id: "opencode-better-subagents",
  setup: async (ctx) => {
    const config = parseConfig(ctx.options);

    // If no agents are configured with chains, no transformation needed
    if (Object.keys(config.agents).length === 0) {
      return;
    }

    const circuitBreaker = new CircuitBreaker();

    await ctx.tool.transform((tools) => {
      tools.update("subagent", (tool) => {
        const originalExecute = tool.execute;
        tool.execute = createSubagentExecutor(
          originalExecute,
          config,
          circuitBreaker,
          async (sessionID) => {
            try {
              await ctx.session.remove({ sessionID });
            } catch {
              // Ignore cleanup errors on already deleted sessions
            }
          },
        );
      });
    });
  },
});
