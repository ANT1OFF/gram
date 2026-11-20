import { GramRpcs, LOCAL_HOST_ID, type HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";
import { threadsMentioned } from "../embedding/readable-by.ts";
import {
  actorEventsOf,
  DEPLOYMENT_RPCS,
  MEMBER_RPCS,
  memberMay,
  setsOnlyOwnView,
  UNRECORDED_RPCS,
  VIEWER_RPCS,
} from "./actor-guard.ts";
import { namesServerDisk, RUNS_IN_FOLDER } from "./server-disk.ts";

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
      // No viewer pins, shows, unpins, opens or lists a page: only a member's own RPCs reach the store.
      "pages.pin",
      "pages.showOffer",
      "pages.unpin",
      "pages.open",
      "pages.list",
    ])
      expect(VIEWER_RPCS.has(tag)).toBe(false);
  });
});

/** How many of the three lists name `tag`. */
const placed = (tag: string) =>
  [VIEWER_RPCS, MEMBER_RPCS, DEPLOYMENT_RPCS].filter((set) => set.has(tag)).length;

describe("what a member may call", () => {
  test("every RPC is a viewer's, a member's or the deployment's, and only one", () => {
    // A new RPC fails here until someone decides whose it is: until then members are refused it.
    const known = [...GramRpcs.requests.keys()];
    expect(known.filter((tag) => placed(tag) !== 1)).toEqual([]);
    expect([...MEMBER_RPCS, ...DEPLOYMENT_RPCS].filter((tag) => !known.includes(tag))).toEqual([]);
  });

  test("leaves the server's own setup to its deployment", () => {
    for (const tag of [
      "agentRuntime.install",
      "profiles.upsert",
      "profiles.setKey",
      "profiles.discoverModels",
      "connectors.add",
      "settings.set",
      "palettes.upsert",
      "sessions.preview",
      "a.callAddedLater",
    ])
      for (const headless of [false, true]) expect(memberMay(tag, {}, headless)).toBe(false);
    expect(memberMay("thread.send", { threadId: "t" }, true)).toBe(true);
    // A server that runs work itself has its members' folders on its disk.
    expect(memberMay("fs.browse", { path: "/" }, false)).toBe(true);
    expect(memberMay("fs.list", { path: "/" }, false)).toBe(true);
  });

  test("keeps a headless server's own disk from its members", () => {
    for (const tag of ["fs.browse", "fs.tree", "projects.add"])
      expect(memberMay(tag, { path: "/" }, true)).toBe(false);
    // A clone there files the repository's origin and reaches nothing: New project adds one so.
    expect(memberMay("projects.clone", { remote: "acme/web" }, true)).toBe(true);
    // A listing lists a thread's folder, never the server's.
    expect(memberMay("fs.list", { path: "/" }, true)).toBe(false);
    expect(memberMay("fs.files", {}, true)).toBe(false);
    expect(memberMay("fs.list", { threadId: "t", path: "src" }, true)).toBe(true);
  });
});

describe("a folder a call runs git or config in, on a headless server", () => {
  const remote = "/home/ada/work/web";
  const placeOf = (path: string) =>
    Effect.succeed((path.startsWith(remote) ? "host-ada" : LOCAL_HOST_ID) as HostId);
  const names = (payload: unknown) => Effect.runSync(namesServerDisk(payload, placeOf));

  test("is a joined machine's, never the server's own", () => {
    expect(names({ repoPath: remote })).toBe(false);
    expect(names({ repoPath: `${remote}/packages/app` })).toBe(false);
    // Where a person could plant a repository: the shared folder's copy, the data folder, home.
    for (const repoPath of ["/data/shared/ws-1/repo", "/var/lib/gram", "/", "~/repo", "repo"])
      expect(names({ repoPath })).toBe(true);
    expect(names({ root: "/data/shared/ws-1/repo" })).toBe(true);
    expect(names({ cwd: "/data" })).toBe(true);
    expect(names({ projectRoot: "/data" })).toBe(true);
    // Without the machines to ask, any named folder counts as the server's.
    expect(Effect.runSync(namesServerDisk({ repoPath: remote }, undefined))).toBe(true);
  });

  test("names only RPCs that exist", () => {
    const tags = new Set(GramRpcs.requests.keys());
    for (const tag of RUNS_IN_FOLDER) expect(tags.has(tag)).toBe(true);
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

describe("the threads a call names, for who may read them", () => {
  test("are found wherever the payload names one, and only threads of this server's", () => {
    expect(
      threadsMentioned({
        threadId: "t1",
        orchestratorThreadId: "t2",
        threadIds: ["t3"],
        answers: [{ threadId: "t4", requestId: "r1" }],
        target: { sourceThreadId: "t5" },
        reviewThreadId: "github-thread",
        text: "t6",
      }),
    ).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });
});
