import { describe, expect, it } from "vitest";

import { makeToolGate } from "./session.ts";

// The tool gate a pause closes (`AgentSession.closeToolGate`): deciding to stop and admitting a call
// happen on one thread, so no call can slip in between, and none admitted is cut off.

const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
};

describe("makeToolGate", () => {
  it("resolves at once with nothing admitted, and refuses every call after", async () => {
    const gate = makeToolGate();
    expect(await settled(gate.close())).toBe(true);
    expect(gate.admit("t1")).toBe(false);
    expect(gate.open).toBe(false);
  });

  it("waits for every admitted call, refusing a new one that starts as the last ends", async () => {
    const gate = makeToolGate();
    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(true);
    const closed = gate.close();
    gate.finished("a");
    expect(await settled(closed)).toBe(false);
    // The next call reaches PreToolUse before the last one's result: refused, never run.
    expect(gate.admit("c")).toBe(false);
    gate.finished("b");
    expect(await settled(closed)).toBe(true);
  });

  it("opens again as the turn ends, which also ends the wait", async () => {
    const gate = makeToolGate();
    gate.admit("a");
    const closed = gate.close();
    gate.turnEnded();
    expect(await settled(closed)).toBe(true);
    expect(gate.admit("next")).toBe(true);
  });

  it("ignores an end for a call it never admitted", async () => {
    const gate = makeToolGate();
    gate.admit("a");
    const closed = gate.close();
    gate.finished("never");
    expect(await settled(closed)).toBe(false);
  });
});
