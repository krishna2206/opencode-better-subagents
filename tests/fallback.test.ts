import { describe, expect, it } from "bun:test";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import {
  createSubagentExecutor,
  extractFailedSessionID,
  filterCatalogCandidates,
  isCancelledError,
  isNonRetryableSubagentError,
  type CatalogModelEntry,
} from "../src/fallback.js";
import type { BetterSubagentsConfig } from "../src/config.js";

const config: BetterSubagentsConfig = {
  cooldownSeconds: 60,
  agents: {
    explore: ["p/model-primary", "p/model-secondary", "p/model-tertiary"],
  },
};

const catalog: CatalogModelEntry[] = [
  { providerID: "p", id: "model-primary", enabled: true, type: "chat", variants: [{ id: "high" }] },
  { providerID: "p", id: "model-secondary", enabled: true, type: "chat", variants: [] },
  { providerID: "p", id: "model-tertiary", enabled: true, type: "chat", variants: [] },
];

describe("error helpers", () => {
  it("detects cancellation and abort errors", () => {
    expect(isCancelledError(new Error("Subagent cancelled (sessionID: ses_123)"))).toBe(true);
    expect(isCancelledError(new Error("User cancelled the run"))).toBe(true);
    expect(isCancelledError(new Error("Subagent failed (sessionID: ses_123): 429 quota exhausted"))).toBe(false);
  });

  it("classifies caller-side errors as non-retryable", () => {
    expect(isNonRetryableSubagentError(new Error("Subagent denied: explore"))).toBe(true);
    expect(isNonRetryableSubagentError(new Error("Subagent depth limit reached (1). Increase ..."))).toBe(true);
    expect(isNonRetryableSubagentError(new Error("Unknown agent: foo"))).toBe(true);
    expect(isNonRetryableSubagentError(new Error("Parent session not found: ses_x"))).toBe(true);
    expect(isNonRetryableSubagentError(new Error("Subagent failed (sessionID: ses_1): 429"))).toBe(false);
    expect(isNonRetryableSubagentError(new Error('Model "p/x" is not available.'))).toBe(false);
  });

  it("extracts child sessionID from failure message", () => {
    expect(extractFailedSessionID(new Error("Subagent failed (sessionID: ses_deadbeef123): 429 quota"))).toBe(
      "ses_deadbeef123",
    );
    expect(extractFailedSessionID(new Error("Subagent failed: network error"))).toBeNull();
  });
});

describe("filterCatalogCandidates", () => {
  it("keeps only enabled chat models with valid variants", () => {
    const entries: CatalogModelEntry[] = [
      { providerID: "a", id: "m1", enabled: true, type: "chat", variants: [{ id: "high" }] },
      { providerID: "b", id: "m2", enabled: false, type: "chat", variants: [] },
      { providerID: "c", id: "img", enabled: true, type: "image", variants: [] },
      { providerID: "d", id: "m4", enabled: true, variants: [] },
    ];
    expect(
      filterCatalogCandidates(["a/m1#high", "a/m1#max", "b/m2", "c/img", "d/m4", "missing/x", "garbage"], entries),
    ).toEqual(["a/m1#high", "d/m4"]);
  });
});

describe("createSubagentExecutor", () => {
  it("passes through without modifying model when caller sets an explicit model", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: "ok" };
      },
      config,
      new CircuitBreaker(),
    );

    const res = await execute(
      { agent: "explore", prompt: "find files", description: "explore", model: "explicit/model" },
      {},
    );
    expect(res).toEqual({ content: "ok" });
    expect(calls[0].model).toBe("explicit/model");
  });

  it("passes through when caller provides an existing sessionID", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: "resumed" };
      },
      config,
      new CircuitBreaker(),
    );

    await execute({ agent: "explore", prompt: "continue", description: "explore", sessionID: "ses_existing" }, {});
    expect(calls[0].model).toBeUndefined();
  });

  it("passes through when agent is not in config", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: "general ok" };
      },
      config,
      new CircuitBreaker(),
    );

    await execute({ agent: "general", prompt: "work", description: "gen" }, {});
    expect(calls[0].model).toBeUndefined();
  });

  it("picks candidate 1 and succeeds", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: `done on ${input.model}` };
      },
      config,
      new CircuitBreaker(),
    );

    const res = await execute({ agent: "explore", prompt: "find", description: "desc" }, {});
    expect(res).toEqual({ content: "done on p/model-primary" });
    expect(calls).toHaveLength(1);
  });

  it("falls back to candidate 2 if candidate 1 fails and cleans up dead session", async () => {
    const cb = new CircuitBreaker();
    const calls: any[] = [];
    const removed: string[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        if (input.model === "p/model-primary") {
          throw new Error("Subagent failed (sessionID: ses_dead_1): 429 quota exhausted");
        }
        return { content: `done on ${input.model}` };
      },
      config,
      cb,
      { removeSession: async (id) => void removed.push(id) },
    );

    const res = await execute({ agent: "explore", prompt: "find", description: "desc" }, {});
    expect(res).toEqual({ content: "done on p/model-secondary" });
    expect(calls.map((c) => c.model)).toEqual(["p/model-primary", "p/model-secondary"]);
    expect(removed).toEqual(["ses_dead_1"]);
    expect(cb.isCoolingDown("p/model-primary")).toBe(true);

    calls.length = 0;
    await execute({ agent: "explore", prompt: "again", description: "desc" }, {});
    expect(calls.map((c) => c.model)).toEqual(["p/model-secondary"]);
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

    await expect(execute({ agent: "explore", prompt: "find", description: "desc" }, {})).rejects.toThrow(
      "Subagent cancelled",
    );
    expect(calls).toHaveLength(1);
    expect(cb.isCoolingDown("p/model-primary")).toBe(false);
  });

  it("does not retry nor cool down models on permission denial or depth limit", async () => {
    for (const message of ["Subagent denied: explore", "Subagent depth limit reached (1). Increase it."]) {
      const cb = new CircuitBreaker();
      const calls: any[] = [];
      const execute = createSubagentExecutor(
        async (input) => {
          calls.push(input);
          throw new Error(message);
        },
        config,
        cb,
      );

      await expect(execute({ agent: "explore", prompt: "find", description: "desc" }, {})).rejects.toThrow(message);
      expect(calls).toHaveLength(1);
      expect(cb.isCoolingDown("p/model-primary")).toBe(false);
    }
  });

  it("throws the last error if all candidates fail", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        throw new Error(`Failed on ${input.model}`);
      },
      config,
      new CircuitBreaker(),
    );

    await expect(execute({ agent: "explore", prompt: "find", description: "desc" }, {})).rejects.toThrow(
      "Failed on p/model-tertiary",
    );
    expect(calls).toHaveLength(3);
  });

  it("skips candidates absent from the catalog", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return { content: `done on ${input.model}` };
      },
      config,
      new CircuitBreaker(),
      { listModels: async () => catalog.filter((m) => m.id !== "model-primary") },
    );

    const res = await execute({ agent: "explore", prompt: "find", description: "desc" }, {});
    expect(res).toEqual({ content: "done on p/model-secondary" });
    expect(calls).toHaveLength(1);
  });

  it("fails fast when no configured model is in the catalog", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return {};
      },
      config,
      new CircuitBreaker(),
      { listModels: async () => [] },
    );

    await expect(execute({ agent: "explore", prompt: "find", description: "desc" }, {})).rejects.toThrow(
      "No configured fallback model",
    );
    expect(calls).toHaveLength(0);
  });

  it("uses the configured chain when the catalog query fails", async () => {
    const calls: any[] = [];
    const execute = createSubagentExecutor(
      async (input) => {
        calls.push(input);
        return {};
      },
      config,
      new CircuitBreaker(),
      {
        listModels: async () => {
          throw new Error("catalog down");
        },
      },
    );

    await execute({ agent: "explore", prompt: "find", description: "desc" }, {});
    expect(calls[0].model).toBe("p/model-primary");
  });

  it("does not clear a cooldown on a background launch and tracks the running session", async () => {
    const cb = new CircuitBreaker();
    cb.markFailure("p/model-primary", 60_000);
    cb.markFailure("p/model-secondary", 60_000);
    cb.markFailure("p/model-tertiary", 60_000);
    const tracked: Array<[string, string]> = [];
    const execute = createSubagentExecutor(
      async () => ({
        output: { sessionID: "ses_bg", status: "running", output: "" },
        metadata: { sessionID: "ses_bg", status: "running" },
      }),
      config,
      cb,
      { onRunningSession: (id, model) => void tracked.push([id, model]) },
    );

    await execute({ agent: "explore", prompt: "find", description: "desc", background: true }, {});
    expect(tracked).toEqual([["ses_bg", "p/model-primary"]]);
    expect(cb.isCoolingDown("p/model-primary")).toBe(true);
  });

  it("tracks a foreground run that was backgrounded mid-flight", async () => {
    const cb = new CircuitBreaker();
    const tracked: string[] = [];
    const execute = createSubagentExecutor(
      async () => ({ metadata: { sessionID: "ses_mid", status: "running" } }),
      config,
      cb,
      { onRunningSession: (id) => void tracked.push(id) },
    );

    await execute({ agent: "explore", prompt: "find", description: "desc" }, {});
    expect(tracked).toEqual(["ses_mid"]);
  });
});
