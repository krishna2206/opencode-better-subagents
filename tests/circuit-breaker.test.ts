import { describe, expect, it } from "bun:test";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("marks failure and expires cooldown accurately", () => {
    const cb = new CircuitBreaker();
    const now = 1000;

    expect(cb.isCoolingDown("model-a", now)).toBe(false);

    cb.markFailure("model-a", 5000, now);
    expect(cb.isCoolingDown("model-a", now + 1000)).toBe(true);
    expect(cb.isCoolingDown("model-a", now + 4999)).toBe(true);
    expect(cb.isCoolingDown("model-a", now + 5000)).toBe(false);
  });

  it("clears cooldown on success", () => {
    const cb = new CircuitBreaker();
    cb.markFailure("model-a", 10000, 1000);
    expect(cb.isCoolingDown("model-a", 2000)).toBe(true);

    cb.markSuccess("model-a");
    expect(cb.isCoolingDown("model-a", 2000)).toBe(false);
  });

  it("filters out cooled-down candidates but falls back to all if all cooled down", () => {
    const cb = new CircuitBreaker();
    const candidates = ["m1", "m2", "m3"];
    const now = 1000;

    cb.markFailure("m1", 5000, now);
    expect(cb.pickCandidates(candidates, now + 1000)).toEqual(["m2", "m3"]);

    cb.markFailure("m2", 5000, now);
    expect(cb.pickCandidates(candidates, now + 1000)).toEqual(["m3"]);

    cb.markFailure("m3", 5000, now);
    // All candidates are in cooldown: return all candidates rather than blocking
    expect(cb.pickCandidates(candidates, now + 1000)).toEqual(["m1", "m2", "m3"]);
  });
});
