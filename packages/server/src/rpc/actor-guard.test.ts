import { GramRpcs } from "@gram/contracts";
import { describe, expect, test } from "vitest";
import { actorEventsOf, setsOnlyOwnView, UNRECORDED_RPCS, VIEWER_RPCS } from "./actor-guard.ts";

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
      "worktree.status",
      "git.branches",
      "thread.suggestions",
    ])
      expect(VIEWER_RPCS.has(tag)).toBe(false);
  });
});

describe("a person's own view", () => {
  test("is a settings change of personal settings and nothing else", () => {
    const grid = { preset: "1", panes: [null] };
    expect(setsOnlyOwnView("settings.set", { patch: { layout: { grid } } })).toBe(true);
    expect(setsOnlyOwnView("settings.set", { patch: { layout: { grid: null } } })).toBe(true);
    for (const patch of [
      {},
      { logLevel: "debug" },
      { layout: {} },
      { layout: { focusMode: true } },
      { layout: { grid, focusMode: true } },
      { layout: { grid }, logLevel: "debug" },
      { grid },
    ])
      expect(setsOnlyOwnView("settings.set", { patch })).toBe(false);
    expect(setsOnlyOwnView("settings.set", {})).toBe(false);
    expect(setsOnlyOwnView("keybindings.set", { patch: { layout: { grid } } })).toBe(false);
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

  test("keeps an id only where it has the shape of one", () => {
    const [named] = actorEventsOf(
      ada,
      "orchestrator.renameFeature",
      { workspaceId: "w1", feature: "the secret launch", id: "a sentence someone typed" },
      5,
    );
    expect(named).toMatchObject({ workspaceId: "w1", data: {} });
    const [patched] = actorEventsOf(
      ada,
      "settings.set",
      { patch: { projects: { "/home/someone/secret plan": { color: "red" } } } },
      5,
    );
    expect(patched?.data).toEqual({ settings: ["projects.*.color"] });
    const many = actorEventsOf(
      ada,
      "thread.respondMany",
      { answers: Array.from({ length: 500 }, () => ({ threadId: "t1", requestId: "r1" })) },
      5,
    );
    expect(many).toHaveLength(200);
  });

  test("names the thread a call started", () => {
    const [created] = actorEventsOf(ada, "thread.create", { projectRoot: "/w" }, 5, { id: "t9" });
    expect(created?.threadId).toBe("t9");
  });
});
