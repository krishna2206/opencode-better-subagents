import { describe, expect, it } from "bun:test";
import { DEFAULT_COOLDOWN_SECONDS, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("returns default values when options are empty or missing", () => {
    expect(parseConfig()).toEqual({
      cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
      agents: {},
    });
    expect(parseConfig({})).toEqual({
      cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
      agents: {},
    });
  });

  it("parses valid agent chains and custom cooldown", () => {
    const parsed = parseConfig({
      cooldownSeconds: 60,
      agents: {
        explore: [
          "claude-code-proxy/claude-sonnet-5-5#high",
          "commandcode-proxy/commandcode-deepseek-v4.1-flash#max",
          "antigravity-proxy/antigravity-gemini-3.8-flash#high",
        ],
      },
    });

    expect(parsed.cooldownSeconds).toBe(60);
    expect(parsed.agents.explore).toEqual([
      "claude-code-proxy/claude-sonnet-5-5#high",
      "commandcode-proxy/commandcode-deepseek-v4.1-flash#max",
      "antigravity-proxy/antigravity-gemini-3.8-flash#high",
    ]);
  });

  it("sanitizes empty strings and invalid entries", () => {
    const parsed = parseConfig({
      cooldownSeconds: -10,
      agents: {
        explore: ["  ", "valid/model", 123 as any],
        general: "not-an-array" as any,
      },
    });

    expect(parsed.cooldownSeconds).toBe(DEFAULT_COOLDOWN_SECONDS);
    expect(parsed.agents.explore).toEqual(["valid/model"]);
    expect(parsed.agents.general).toBeUndefined();
  });
});
