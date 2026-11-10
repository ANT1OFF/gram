import { GramRpcs } from "@gram/contracts";
import { describe, expect, test } from "vitest";
import { actorEventsOf, UNRECORDED_RPCS, VIEWER_RPCS } from "./actor-guard.ts";

const ada = { id: "user-ada", name: "Ada", role: "member" as const };

describe("what a viewer may call", () => {
  test("names only RPCs that exist, and none that goes unrecorded", () => {
    const known = new Set(GramRpcs.requests.keys());
    expect([...VIEWER_RPCS].filter((tag) => !known.has(tag))).toEqual([]);
    expect([...UNRECORDED_RPCS].filter((tag) => !known.has(tag))).toEqual([]);
    expect([...VIEWER_RPCS].filter((tag) => UNRECORDED_RPCS.has(tag))).toEqual([]);
  });

  test("leaves out everything that sends, answers, changes or runs", () => {
    // By name, so an addition to the list that changes something has to argue with this test.
    const changes =
      /\.(send|steer|respond\w*|answer|set\w*|create|close|remove|delete|save|write|upsert|add\w*|open|input|run|merge|push|start\w*|adopt|restore|update\w*|install|rename|reorder|fork|rewind|interrupt|dismiss|accept|upload|clone|forget)$/;
    expect([...VIEWER_RPCS].filter((tag) => changes.test(tag))).toEqual([]);
    for (const tag of [
      "thread.send",
      "thread.respond",
      "settings.set",
      "terminal.open",
      "fs.browse",
    ])
      expect(VIEWER_RPCS.has(tag)).toBe(false);
  });
});

describe("what is recorded of a call", () => {
  test("is what identifies it, never what was typed", () => {
    const [sent] = actorEventsOf(
      ada,
      "thread.send",
      { threadId: "t1", input: { text: "the secret plan" }, clientMessageId: "m1" },
      5,
    );
    expect(sent).toEqual({
      at: 5,
      actor: ada,
      action: "thread.send",
      threadId: "t1",
      workspaceId: undefined,
      data: { clientMessageId: "m1" },
    });
    expect(JSON.stringify(sent)).not.toContain("secret");

    const [answered] = actorEventsOf(
      ada,
      "thread.respond",
      {
        threadId: "t1",
        requestId: "r1",
        answer: { kind: "approval", decision: "deny", scope: "once", message: "not that way" },
      },
      5,
    );
    expect(answered?.data).toEqual({
      requestId: "r1",
      answer: { kind: "approval", decision: "deny", scope: "once" },
    });

    const [changed] = actorEventsOf(
      ada,
      "settings.set",
      { patch: { logLevel: "debug", agents: { idleEvictMinutes: 5 } } },
      5,
    );
    expect(changed?.data).toEqual({ settings: ["logLevel", "agents.idleEvictMinutes"] });
  });

  test("is one entry per answer when several are given at once", () => {
    const events = actorEventsOf(
      ada,
      "thread.respondMany",
      {
        answers: [
          { threadId: "t1", requestId: "r1", answer: { kind: "approval", decision: "allow" } },
          { threadId: "t2", requestId: "r2", answer: { kind: "plan", decision: "reject" } },
        ],
      },
      5,
    );
    expect(events.map((event) => [event.threadId, event.data])).toEqual([
      ["t1", { requestId: "r1", answer: { kind: "approval", decision: "allow" } }],
      ["t2", { requestId: "r2", answer: { kind: "plan", decision: "reject" } }],
    ]);
  });

  test("names the thread a call started", () => {
    const [created] = actorEventsOf(ada, "thread.create", { projectRoot: "/w" }, 5, { id: "t9" });
    expect(created?.threadId).toBe("t9");
  });
});
