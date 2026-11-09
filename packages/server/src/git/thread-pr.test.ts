import { describe, expect, it } from "@effect/vitest";
import { HostId, LOCAL_HOST_ID, type Thread, ThreadId } from "@gram/contracts";
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import { heldCheckoutPaths, usedCheckoutPaths } from "../runtime/create-in-checkout.ts";
import { removeDir, tempDir } from "./test-repo.ts";
import { ghFolder, ON_ANOTHER_MACHINE, pathHere, threadFolder } from "./thread-pr.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");

const thread = (path: string, hostId?: HostId) =>
  ({
    id: ThreadId.make(`t-${hostId ?? "local"}`),
    checkout: { kind: "worktree", path, ...(hostId === undefined ? {} : { hostId }) },
  }) as unknown as Thread;

/** Hosts that place every path on `id`. */
const placing = (id: HostId | undefined) => ({ placeOf: () => Effect.succeed(id) });

describe("a thread on another machine, by its checkout's path here", () => {
  it.effect("never has this machine's git run in a folder here at that path", () =>
    Effect.gen(function* () {
      // A folder here at the very path the other machine's checkout has.
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      expect(yield* threadFolder(thread(dir))).toBe(dir);
      // Before, this was `dir` too, and push, diff and PR creation ran in this machine's folder.
      const refused = yield* threadFolder(thread(dir, MACHINE)).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "GitError", message: ON_ANOTHER_MACHINE });
      // Calls that name the repository start gh in a folder here that isn't the checkout.
      expect(yield* ghFolder(thread(dir))).toBe(dir);
      expect(yield* ghFolder(thread(dir, MACHINE))).toBe(tmpdir());
    }),
  );

  it.effect("refuses a path-only git call for a folder that isn't this machine's", () =>
    Effect.gen(function* () {
      yield* pathHere(placing(LOCAL_HOST_ID), "/srv/work");
      const elsewhere = yield* pathHere(placing(MACHINE), "/srv/work").pipe(Effect.flip);
      expect(elsewhere.message).toContain("another machine's folder");
      const both = yield* pathHere(placing(undefined), "/srv/work").pipe(Effect.flip);
      expect(both.message).toContain("more than one machine");
    }),
  );

  it("doesn't hold this machine's folder at the same path", () => {
    const threads = [
      {
        checkout: { kind: "worktree", path: "/srv/work/a", hostId: MACHINE },
        currentCheckout: { kind: "worktree", path: "/srv/work/b", hostId: MACHINE },
        extraCheckouts: [{ kind: "worktree", path: "/srv/lib/a" }],
      },
    ] as unknown as ReadonlyArray<Thread>;
    // Before, every machine's paths counted on every machine.
    expect(heldCheckoutPaths(threads, LOCAL_HOST_ID)).toEqual(["/srv/lib/a"]);
    expect(usedCheckoutPaths(threads, LOCAL_HOST_ID)).toEqual(["/srv/lib/a"]);
    expect(usedCheckoutPaths(threads, MACHINE)).toEqual(["/srv/work/a", "/srv/work/b"]);
    // Without a machine, all of them, as before.
    expect(usedCheckoutPaths(threads)).toEqual(["/srv/work/a", "/srv/lib/a", "/srv/work/b"]);
  });
});
