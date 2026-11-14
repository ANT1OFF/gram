// What `resumeHost` does about a thread's folder that isn't on the machine's disk: asks the host
// to make it again from what a stop kept, for a folder Gram made from a clone there, and reports
// it missing otherwise. The host's side is `stop.test.ts`'s, with real repositories.

import { describe, expect, it } from "@effect/vitest";
import {
  HostFailed,
  type HostId,
  type HostStopRestored,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { makeStopMarks } from "./stop-marks.ts";
import type { RestoreRequest } from "./stop.ts";
import { cloneIdentityOf, cloneUrlOf } from "./repos.ts";
import { resumeHost, type StopResumeDeps } from "./stop-resume.ts";

const MACHINE = "m-1" as HostId;
const URL = "https://git.example.test/acme/widgets.git";
const COMMIT = "a".repeat(40);

const thread = (id: string, checkout: Partial<Thread["checkout"]> & { path: string }) =>
  ({
    id: id as ThreadId,
    checkout: { kind: "worktree", hostId: MACHINE, ...checkout },
  }) as unknown as Thread;

const THREADS = [
  thread("t-worker", {
    path: "/clones/widgets-trees/worker",
    branch: "gram/worker",
    repoRoot: "/clones/widgets",
    cloneIdentity: cloneIdentityOf(URL)!,
  }),
  thread("t-here", { path: "/clones/widgets-trees/here", cloneIdentity: cloneIdentityOf(URL)! }),
  // A folder the user picked there: Gram didn't make it from a clone.
  thread("t-folder", { kind: "main", path: "/home/dev/project" }),
  thread("t-nothing", {
    path: "/clones/widgets-trees/nothing",
    branch: "gram/nothing",
    cloneIdentity: cloneIdentityOf(URL)!,
  }),
  thread("t-refused", {
    path: "/clones/widgets-trees/refused",
    cloneIdentity: cloneIdentityOf(URL)!,
  }),
];

/** A machine whose disk holds only `present`, and what it was asked to put back. */
const machine = (present: ReadonlyArray<string>, restores: boolean) => {
  const asked: Array<RestoreRequest> = [];
  const restore = (request: RestoreRequest) =>
    Effect.suspend((): Effect.Effect<HostStopRestored, HostFailed> => {
      asked.push(request);
      if (request.threadId === "t-nothing")
        return Effect.succeed({ restored: false, note: "Nothing was kept of it at the remote." });
      if (request.threadId === "t-refused")
        return Effect.fail(new HostFailed({ message: "git fetch failed" }));
      return Effect.succeed({ restored: true, commit: COMMIT, uncommitted: true });
    });
  const started: Array<ThreadId> = [];
  const stops = makeStopMarks();
  stops.stopped(MACHINE, ["t-worker" as ThreadId, "t-folder" as ThreadId]);
  const deps = {
    hosts: {
      connection: () =>
        Effect.succeed({
          git: { present: (cwd: string) => Effect.succeed(present.includes(cwd)) },
          stop: restores ? { restore } : {},
        }),
      stops,
    },
    store: { listThreads: Effect.succeed(THREADS) },
    runtimes: {
      startSession: (threadId: ThreadId) => Effect.sync(() => void started.push(threadId)),
    },
  } as unknown as StopResumeDeps;
  return { deps, asked, started };
};

describe("resuming a machine on another disk", () => {
  it.effect("has each missing folder Gram made from a clone put back, and opens its session", () =>
    Effect.gen(function* () {
      const { deps, asked, started } = machine(["/clones/widgets-trees/here"], true);
      const resumed = yield* resumeHost(deps, MACHINE, { remote: "mirror" });
      expect(asked).toEqual([
        {
          threadId: "t-worker",
          cwd: "/clones/widgets-trees/worker",
          url: URL,
          branch: "gram/worker",
          remote: "mirror",
        },
        {
          threadId: "t-nothing",
          cwd: "/clones/widgets-trees/nothing",
          url: URL,
          branch: "gram/nothing",
          remote: "mirror",
        },
        { threadId: "t-refused", cwd: "/clones/widgets-trees/refused", url: URL, remote: "mirror" },
      ]);
      expect(resumed.restored).toEqual([
        {
          threadId: "t-worker",
          cwd: "/clones/widgets-trees/worker",
          commit: COMMIT,
          uncommitted: true,
        },
      ]);
      expect(resumed.missing).toEqual([
        { threadId: "t-folder", cwd: "/home/dev/project" },
        {
          threadId: "t-nothing",
          cwd: "/clones/widgets-trees/nothing",
          note: "Nothing was kept of it at the remote.",
        },
        { threadId: "t-refused", cwd: "/clones/widgets-trees/refused", note: "git fetch failed" },
      ]);
      // The restored thread's session opens again; the one still missing its folder is left.
      expect(started).toEqual(["t-worker"]);
      expect(resumed.reopened).toEqual(["t-worker"]);
      expect(resumed.left).toEqual([
        { threadId: "t-folder", reason: "Its folder isn't on the machine." },
      ]);
    }),
  );

  it.effect("reports them missing, as before, on a host that puts nothing back", () =>
    Effect.gen(function* () {
      const { deps, asked, started } = machine(["/clones/widgets-trees/here"], false);
      const resumed = yield* resumeHost(deps, MACHINE);
      expect(asked).toEqual([]);
      expect(resumed.restored).toEqual([]);
      expect(resumed.missing.map((entry) => entry.threadId)).toEqual([
        "t-worker",
        "t-folder",
        "t-nothing",
        "t-refused",
      ]);
      expect(started).toEqual([]);
    }),
  );

  it("rebuilds a repository's URL from the identity recorded when it was cloned", () => {
    for (const url of [
      URL,
      "https://git.example.test:8443/group/sub/widgets",
      "ssh://git@git.example.test/acme/widgets.git",
      "ssh://git@git.example.test:2222/acme/widgets.git",
      "git@git.example.test:acme/widgets.git",
    ]) {
      const identity = cloneIdentityOf(url)!;
      expect(cloneIdentityOf(cloneUrlOf(identity)!)).toBe(identity);
    }
    expect(cloneUrlOf(cloneIdentityOf(URL)!)).toBe(URL);
    expect(cloneUrlOf("not json")).toBeUndefined();
    expect(cloneUrlOf(JSON.stringify(["file:", "h", "1", "", "/x/y"]))).toBeUndefined();
    expect(cloneUrlOf(JSON.stringify(["https:", "h", "443", "", "/../x/y"]))).toBeUndefined();
  });
});
