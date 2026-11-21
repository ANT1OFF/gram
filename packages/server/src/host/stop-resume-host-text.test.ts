// What a resume keeps of a host's own failure text: held to a size, so a host can't grow the
// machine's record (and the one file every machine's is written in) past what can be kept.

import { describe, expect, it } from "@effect/vitest";
import { HostFailed, type HostId, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { BLOCK_REASON_MAX_CHARS, makeStopMarks } from "./stop-marks.ts";
import { cloneIdentityOf } from "./repos.ts";
import { resumeHost, type StopResumeDeps } from "./stop-resume.ts";

const MACHINE = "m-1" as HostId;
const URL = "https://git.example.test/acme/widgets.git";
const THREAD = {
  id: "t-refused" as ThreadId,
  checkout: {
    kind: "worktree",
    hostId: MACHINE,
    path: "/clones/widgets-trees/refused",
    cloneIdentity: cloneIdentityOf(URL)!,
  },
} as unknown as Thread;

describe("a resume a host fails with a long message", () => {
  it.effect("keeps only so much of it, in the answer and the thread's block", () =>
    Effect.gen(function* () {
      const stops = makeStopMarks();
      const deps = {
        hosts: {
          connection: () =>
            Effect.succeed({
              git: { present: () => Effect.succeed(false) },
              stop: {
                restore: () =>
                  Effect.fail(new HostFailed({ message: "x".repeat(5 * 1024 * 1024) })),
              },
            }),
          stops,
        },
        store: { listThreads: Effect.succeed([THREAD]) },
        runtimes: { startSession: () => Effect.void },
      } as unknown as StopResumeDeps;
      const resumed = yield* resumeHost(deps, MACHINE);
      expect(resumed.refused[0]?.note.length).toBeLessThanOrEqual(1024);
      expect(stops.blocked(MACHINE, THREAD.id)?.length).toBeLessThanOrEqual(BLOCK_REASON_MAX_CHARS);
    }),
  );
});
