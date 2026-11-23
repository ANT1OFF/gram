import { HostId, HostUnavailable, type Thread, ThreadId, WorkspaceId } from "@gram/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerHost } from "../host/worker-host.ts";
import { sharedOnHost } from "./host-shared.ts";
import { makeSharedFolders } from "./shared-folders.ts";

let dir: string;
const REMOTE = HostId.make("machine-1");
const WS = WorkspaceId.make("ws-1");

const threadOn = (hostId: HostId | undefined, extra: Record<string, unknown> = {}): Thread =>
  ({
    id: ThreadId.make("t-1"),
    workspaceId: WS,
    checkout: { path: "/work", ...(hostId === undefined ? {} : { hostId }) },
    ...extra,
  }) as unknown as Thread;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gram-shared-folders-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const folders = (
  connected: boolean,
  options: { slowWrites?: (path: string) => boolean; firstCopy?: Duration.Input } = {},
) => {
  const plain = sharedOnHost(join(dir, "host"));
  const shared = {
    ...plain,
    write: (workspaceId: WorkspaceId, write: Parameters<typeof plain.write>[1]) =>
      options.slowWrites?.(write.path)
        ? Effect.sleep("300 millis").pipe(Effect.andThen(plain.write(workspaceId, write)))
        : plain.write(workspaceId, write),
  };
  const get = (id: HostId) =>
    connected && id === REMOTE
      ? Effect.succeed({ id, shared } as unknown as WorkerHost)
      : Effect.fail(new HostUnavailable({ hostId: id, message: "away" }));
  return makeSharedFolders(join(dir, "data"), { get }, "20 millis", {
    round: "10 seconds",
    firstCopy: options.firstCopy ?? "10 seconds",
  });
};

describe("shared folders", () => {
  it("gives a thread on this machine the folder kept with Gram's data", async () => {
    const path = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(folders(true), (f) => f.forSession(threadOn(undefined)))),
    );
    expect(path).toBe(join(dir, "data", "shared", WS));
  });

  it("gives none to a thread with no workspace, or to a memory update", async () => {
    const [solo, dream] = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(folders(true), (f) =>
          Effect.all([
            f.forSession(threadOn(undefined, { workspaceId: undefined })),
            f.forSession(threadOn(undefined, { role: "dream" })),
          ]),
        ),
      ),
    );
    expect(solo).toBeUndefined();
    expect(dream).toBeUndefined();
  });

  it("gives a thread on another machine its mirror, in step, and keeps it so", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* folders(true);
          const own = yield* f.folderOf(WS);
          yield* Effect.promise(() => writeFile(join(own!, "brief.md"), "from here"));
          const path = yield* f.forSession(threadOn(REMOTE));
          expect(path).toBe(join(dir, "host", WS));
          expect(yield* Effect.promise(() => readFile(join(path!, "brief.md"), "utf8"))).toBe(
            "from here",
          );
          yield* Effect.promise(() => writeFile(join(path!, "report.md"), "from there"));
          yield* Effect.sleep("200 millis");
          expect(yield* Effect.promise(() => readFile(join(own!, "report.md"), "utf8"))).toBe(
            "from there",
          );
        }),
      ),
    );
  });

  it("opens a newly joined machine's first session without waiting for the whole folder", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* folders(true, {
            slowWrites: (path) => path.startsWith("evidence/"),
            firstCopy: "100 millis",
          });
          const own = yield* f.folderOf(WS);
          yield* Effect.promise(async () => {
            await mkdir(join(own!, "evidence"));
            for (const n of [1, 2, 3, 4, 5])
              await writeFile(join(own!, "evidence", `shot-${n}.png`), "x".repeat(4096 * n));
            await writeFile(join(own!, "notes.md"), "read me first");
          });
          const started = Date.now();
          const path = yield* f.forSession(threadOn(REMOTE));
          // Five slow copies would hold it 1.5 s; it waits only the first copy's 100 ms.
          expect(Date.now() - started).toBeLessThan(1000);
          // The smallest file went first, so the notes are there when the session starts.
          expect(yield* Effect.promise(() => readFile(join(path!, "notes.md"), "utf8"))).toBe(
            "read me first",
          );
          // The rest follows in the background.
          yield* Effect.sleep("2500 millis");
          expect(
            yield* Effect.promise(() => readFile(join(path!, "evidence", "shot-5.png"), "utf8")),
          ).toHaveLength(4096 * 5);
        }),
      ),
    );
  });

  it("opens a session without one when its machine is away", async () => {
    const path = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(folders(false), (f) => f.forSession(threadOn(REMOTE)))),
    );
    expect(path).toBeUndefined();
  });
});
