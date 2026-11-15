// Each workspace's shared folder: plain files every thread in the workspace reads and writes, kept
// with Gram's own data at `<data>/shared/<workspace>/`, so they outlive any one thread or machine.
//
// A thread on this machine is given that folder itself. A thread on another machine is given its
// host's mirror (`host.shared.*`), which a round every few seconds keeps in step with this one
// (`sync.ts`) while the machine is connected: changes go both ways, the later write wins, and what
// the last round agreed on is kept beside, so a delete on either side is a delete on the other,
// across a restart too. Solo threads, which have no workspace, and memory updates get no folder.
//
// Workspace memory is separate: it is the orchestrator's to curate and workers only read it. The
// shared folder has no curator.

import {
  effectiveCheckout,
  type HostId,
  hostOf,
  isLocalHost,
  isSharedWorkspaceId,
  type Thread,
  type WorkspaceId,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServerConfig } from "../config.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { WorkerHosts, type WorkerHostsShape } from "../host/worker-host.ts";
import { sharedTrees, sideOf } from "./host-shared.ts";
export { sharedFolderNote } from "./note.ts";
import { type SharedBase, type SharedSide, syncRound } from "./sync.ts";

/** How often a connected machine's mirror is brought in step. */
export const SHARED_SYNC_EVERY = Duration.seconds(5);
/** How long a session about to open waits for its mirror's first round. */
const FIRST_ROUND_WAIT = Duration.seconds(30);
/** Rounds in a row a machine may be away before its mirror is let go, until a session opens again. */
const AWAY_ROUNDS = 60;

export interface SharedFoldersShape {
  /**
   * The folder a thread's session is given, on the machine it runs on, brought in step first; or
   * `undefined` for a thread with none: no workspace, a memory update, or a machine that can't keep
   * one. Never fails: a folder that can't be had is a session without one.
   */
  readonly forSession: (thread: Thread) => Effect.Effect<string | undefined>;
  /** The control plane's own folder for a workspace, made when it isn't there. */
  readonly folderOf: (workspaceId: WorkspaceId) => Effect.Effect<string | undefined>;
  /** One round now for each workspace mirrored on `hostId`: before it stops, say. */
  readonly flush: (hostId: HostId) => Effect.Effect<void>;
}

const keyOf = (hostId: HostId, workspaceId: WorkspaceId) => `${hostId}\u0000${workspaceId}`;

export class SharedFolders extends Context.Service<SharedFolders, SharedFoldersShape>()(
  "@gram/server/SharedFolders",
) {
  static readonly layer: Layer.Layer<SharedFolders, never, ServerConfig | WorkerHosts> =
    Layer.effect(
      SharedFolders,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const hosts = yield* WorkerHosts;
        return yield* makeSharedFolders(config.dataDir, hosts);
      }),
    );
}

/** The shared folders under `dataDir`, mirrored to `hosts`' machines. */
export const makeSharedFolders = (
  dataDir: string,
  hosts: Pick<WorkerHostsShape, "get">,
  every: Duration.Input = SHARED_SYNC_EVERY,
) =>
  Effect.gen(function* () {
    const treeOf = sharedTrees(join(dataDir, "shared"));
    const basesDir = join(dataDir, "shared-sync");
    const rounds = makeKeyedLock<string>();
    const mirrors = yield* FiberMap.make<string>();
    /** The workspaces mirrored on each machine. */
    const mirrored = new Map<HostId, Set<WorkspaceId>>();

    const baseFile = (hostId: HostId, workspaceId: WorkspaceId) =>
      join(basesDir, Buffer.from(hostId).toString("hex"), `${workspaceId}.json`);

    const readBase = (hostId: HostId, workspaceId: WorkspaceId) =>
      Effect.promise(async (): Promise<SharedBase> => {
        const text = await readFile(baseFile(hostId, workspaceId), "utf8").catch(() => undefined);
        if (text === undefined) return {};
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null) return {};
          return Object.fromEntries(
            Object.entries(parsed).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string",
            ),
          );
        } catch {
          return {};
        }
      });

    const writeBase = (hostId: HostId, workspaceId: WorkspaceId, base: SharedBase) =>
      Effect.tryPromise(async () => {
        const file = baseFile(hostId, workspaceId);
        await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
        await writeFile(`${file}.partial`, JSON.stringify(base), { mode: 0o600 });
        await rename(`${file}.partial`, file);
      });

    const ownSide = (workspaceId: WorkspaceId) =>
      treeOf(workspaceId).pipe(
        Effect.map((tree): SharedSide => ({
          list: tree.list,
          read: tree.read,
          write: tree.write,
          remove: tree.remove,
        })),
      );

    /** One round for a workspace on a machine; false when the machine isn't there to have one. */
    const round = (hostId: HostId, workspaceId: WorkspaceId) =>
      rounds.withLock(
        keyOf(hostId, workspaceId),
        Effect.gen(function* () {
          const host = yield* hosts.get(hostId).pipe(Effect.option);
          if (host._tag === "None" || host.value.shared === undefined) return false;
          const own = yield* ownSide(workspaceId);
          const base = yield* readBase(hostId, workspaceId);
          const done = yield* syncRound(own, sideOf(host.value.shared, workspaceId), base);
          if (JSON.stringify(done.base) !== JSON.stringify(base))
            yield* writeBase(hostId, workspaceId, done.base);
          if (done.copied + done.deleted > 0 || done.deferred > 0)
            yield* Effect.logDebug("shared folder: a round").pipe(
              Effect.annotateLogs({
                hostId,
                workspaceId,
                copied: done.copied,
                deleted: done.deleted,
                deferred: done.deferred,
              }),
            );
          return true;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("shared folder: a round failed").pipe(
              Effect.annotateLogs({ hostId, workspaceId, cause: String(cause) }),
              Effect.as(true),
            ),
          ),
        ),
      );

    /** Rounds for a workspace on a machine until the machine has been away a while. */
    const mirror = (hostId: HostId, workspaceId: WorkspaceId) =>
      Effect.gen(function* () {
        let away = 0;
        while (away < AWAY_ROUNDS) {
          yield* Effect.sleep(every);
          away = (yield* round(hostId, workspaceId)) ? 0 : away + 1;
        }
        mirrored.get(hostId)?.delete(workspaceId);
      });

    const keep = (hostId: HostId, workspaceId: WorkspaceId) =>
      Effect.gen(function* () {
        let set = mirrored.get(hostId);
        if (set === undefined) {
          set = new Set();
          mirrored.set(hostId, set);
        }
        set.add(workspaceId);
        yield* FiberMap.run(mirrors, keyOf(hostId, workspaceId), mirror(hostId, workspaceId), {
          onlyIfMissing: true,
        });
      });

    const folderOf: SharedFoldersShape["folderOf"] = (workspaceId) =>
      treeOf(workspaceId).pipe(
        Effect.flatMap((tree) => tree.open),
        Effect.catchCause((cause) =>
          Effect.logWarning("shared folder: couldn't make one").pipe(
            Effect.annotateLogs({ workspaceId, cause: String(cause) }),
            Effect.as(undefined),
          ),
        ),
      );

    const forSession: SharedFoldersShape["forSession"] = (thread) =>
      Effect.gen(function* () {
        const workspaceId = thread.workspaceId;
        if (workspaceId === undefined || thread.role === "dream") return undefined;
        if (!isSharedWorkspaceId(workspaceId)) return undefined;
        const checkout = effectiveCheckout(thread);
        if (isLocalHost(checkout)) return yield* folderOf(workspaceId);
        const hostId = hostOf(checkout);
        const host = yield* hosts.get(hostId).pipe(Effect.option);
        if (host._tag === "None" || host.value.shared === undefined) return undefined;
        const own = yield* folderOf(workspaceId);
        if (own === undefined) return undefined;
        const { path } = yield* host.value.shared.open(workspaceId);
        yield* round(hostId, workspaceId).pipe(
          Effect.timeoutOption(FIRST_ROUND_WAIT),
          Effect.asVoid,
        );
        yield* keep(hostId, workspaceId);
        return path;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("shared folder: a session opens without one").pipe(
            Effect.annotateLogs({ threadId: thread.id, cause: String(cause) }),
            Effect.as(undefined),
          ),
        ),
      );

    const flush: SharedFoldersShape["flush"] = (hostId) =>
      Effect.forEach(
        [...(mirrored.get(hostId) ?? [])],
        (workspaceId) => round(hostId, workspaceId),
        {
          discard: true,
        },
      );

    return SharedFolders.of({ forSession, folderOf, flush });
  });
