// A reply's files from a thread on another machine are read there only through a host whose
// `part` checks the real path it opens against the checkout (`file-parts-contained`): an older
// host is refused, never read from with a check a swapped link can race.
import { describe, expect, it } from "@effect/vitest";
import type { HostId, Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { HostFileReads } from "../host/file-reads.ts";
import { readReplyFiles } from "./reply-files.ts";

const thread = {
  id: "t1",
  checkout: { kind: "main", path: "/work/repo", hostId: "box" as HostId },
} as unknown as Thread;

const machinesWith = (reads: Partial<HostFileReads>) => ({
  dir: "/data/attachments",
  readsFor: () => Effect.succeed({ name: "box", reads: reads as HostFileReads }),
});

describe("a reply's files on another machine", () => {
  it.effect("are refused from a host that can't contain its reads", () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = [];
      const part = (...args: Array<unknown>) => {
        asked.push(args);
        return Effect.succeed({ path: "/work/repo/a.txt", size: 2, mtime: 1, data: "aGk=" });
      };
      const old = yield* readReplyFiles(thread, ["a.txt"], machinesWith({ part }), "/own").pipe(
        Effect.flip,
      );
      expect(old).toContain("older than this Gram");
      expect(asked).toEqual([]);

      const read = yield* readReplyFiles(
        thread,
        ["a.txt"],
        machinesWith({ part, partsContained: true }),
        "/own",
      );
      expect(read.map((file) => file.bytes.toString())).toEqual(["hi"]);
      // Scoped to the checkout alone, with nothing outside it allowed.
      const [path, roots, outside, offset] = asked[0] as Array<unknown>;
      expect([path, roots, outside, offset]).toMatchObject([
        "a.txt",
        ["/work/repo"],
        { allowed: false },
        0,
      ]);
    }),
  );
});
