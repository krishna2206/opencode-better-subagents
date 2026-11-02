import { describe, expect, it } from "bun:test";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { createSubagentExecutor, extractFailedSessionID, isCancelledError } from "../src/fallback.js";
import type { BetterSubagentsConfig } from "../src/config.js";

const config: BetterSubagentsConfig = {
  cooldownSeconds: 60,
  agents: {
    explore: ["model-primary", "model-secondary", "model-tertiary"],
  },
};

describe("error helpers", () => {
  it("detects cancellation and abort errors", () => {
    expect(isCancelledError(new Error("Subagent cancelled (sessionID: ses_123)"))).toBe(true);
    expect(isCancelledError(new Error("User cancelled the run"))).toBe(true);
    expect(isCancelledError(new Error("Subagent failed (sessionID: ses_123): 429 quota exhausted"))).toBe(false);
  });

  it("extracts child sessionID from failure message", () => {
    expect(extractFailedSessionID(new Error("Subagent failed (sessionID: ses_deadbeef123): 429 quota"))).toBe(
      "ses_deadbeef123",
    );
    expect(extractFailedSessionID(new Error("Subagent failed: network error"))).toBeNull();
  });
});

describe("createSubagentExecutor", () => {
  it("passes through without modifying model when caller sets an explicit model", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: "ok" };
      },
      config,
      cb,
    );

    const res = await execute(
      { agent: "explore", prompt: "find files", description: "explore", model: "explicit/model" },
      {},
    );
    expect(res).toEqual({ content: "ok" });
    expect(calls[0].model).toBe("explicit/model");
  });

  it("passes through when caller provides an existing sessionID", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: "resumed" };
      },
      config,
      cb,
    );

    const res = await execute(
      { agent: "explore", prompt: "continue", description: "explore", sessionID: "ses_existing" },
      {},
    );
    expect(res).toEqual({ content: "resumed" });
    expect(calls[0].model).toBeUndefined();
  });

  it("passes through when agent is not in config", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: "general ok" };
      },
      config,
      cb,
    );

    const res = await execute({ agent: "general", prompt: "work", description: "gen" }, {});
    expect(res).toEqual({ content: "general ok" });
    expect(calls[0].model).toBeUndefined();
  });

  it("picks candidate 1 and succeeds", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: `done on ${input.model}` };
      },
      config,
      cb,
    );

    const res = await execute({ agent: "explore", prompt: "find", description: "desc" }, {});
    expect(res).toEqual({ content: "done on model-primary" });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("model-primary");
  });

  it("falls back to candidate 2 if candidate 1 fails and cleans up dead session", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const removedSessions: string[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        if (input.model === "model-primary") {
          throw new Error("Subagent failed (sessionID: ses_dead_1): 429 quota exhausted");
        }
        return { content: `done on ${input.model}` };
      },
      config,
      cb,
      async (sessionID) => {
        removedSessions.push(sessionID);
      },
    );

    const res = await execute({ agent: "explore", prompt: "find", description: "desc" }, {});
    expect(res).toEqual({ content: "done on model-secondary" });
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe("model-primary");
    expect(calls[1].model).toBe("model-secondary");
    expect(removedSessions).toEqual(["ses_dead_1"]);
    // model-primary should now be in cooldown
    expect(cb.isCoolingDown("model-primary")).toBe(true);
    expect(cb.isCoolingDown("model-secondary")).toBe(false);

    // Next run immediately skips model-primary due to circuit breaker
    calls.length = 0;
    const res2 = await execute({ agent: "explore", prompt: "find again", description: "desc" }, {});
    expect(res2).toEqual({ content: "done on model-secondary" });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("model-secondary");
  });

  it("does not retry when cancelled by user", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        throw new Error("Subagent cancelled (sessionID: ses_child)");
      },
      config,
      cb,
    );

    expect(execute({ agent: "explore", prompt: "find", description: "desc" }, {})).rejects.toThrow(
      "Subagent cancelled",
    );
    expect(calls).toHaveLength(1);
    expect(cb.isCoolingDown("model-primary")).toBe(false);
  });

  it("throws the last error if all candidates fail", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        throw new Error(`Failed on ${input.model}`);
      },
      config,
      cb,
    );

    expect(execute({ agent: "explore", prompt: "find", description: "desc" }, {})).rejects.toThrow(
      "Failed on model-tertiary",
    );
    expect(calls).toHaveLength(3);
  });
});
