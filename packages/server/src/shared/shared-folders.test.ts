import { HostId, HostUnavailable, type Thread, ThreadId, WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerHost } from "../host/worker-host.ts";
import { sharedOnHost } from "./host-shared.ts";
import { makeSharedFolders } from "./shared-folders.ts";

let dir: string;
const REMOTE = HostId.make("machine-1");
const WS = WorkspaceId.make("ws-1");

const threadOn = (hostId: HostId | undefined, extra: Partial<Thread> = {}): Thread =>
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

const folders = (connected: boolean) => {
  const shared = sharedOnHost(join(dir, "host"));
  const get = (id: HostId) =>
    connected && id === REMOTE
      ? Effect.succeed({ id, shared } as unknown as WorkerHost)
      : Effect.fail(new HostUnavailable({ hostId: id, message: "away" }));
  return makeSharedFolders(join(dir, "data"), { get }, "20 millis");
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

  it("opens a session without one when its machine is away", async () => {
    const path = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(folders(false), (f) => f.forSession(threadOn(REMOTE)))),
    );
    expect(path).toBeUndefined();
  });
});
