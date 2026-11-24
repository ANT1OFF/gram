import { HostFailed, HostId, type HostStopRestored, type Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { cloneIdentityOf } from "./repos.ts";
import { makeStopMarks } from "./stop-marks.ts";
import type { StopResumeDeps } from "./stop-resume.ts";
import type { RestoreRequest } from "./stop.ts";

export const MACHINE = HostId.make("m-1");
export const URL = "https://git.example.test/acme/widgets.git";
export const COMMIT = "a".repeat(40);

export const thread = (id: string, checkout: Partial<Thread["checkout"]> & { path: string }) =>
  ({
    id: ThreadId.make(id),
    checkout: { kind: "worktree", hostId: MACHINE, ...checkout },
  }) as unknown as Thread;

export const THREADS = [
  thread("t-worker", {
    path: "/clones/widgets-trees/worker",
    branch: "gram/worker",
    repoRoot: "/clones/widgets",
    cloneIdentity: cloneIdentityOf(URL)!,
  }),
  thread("t-here", { path: "/clones/widgets-trees/here", cloneIdentity: cloneIdentityOf(URL)! }),
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
export const machine = (present: ReadonlyArray<string>, restores: boolean) => {
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
  stops.stopped(MACHINE, [ThreadId.make("t-worker"), ThreadId.make("t-folder")]);
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
