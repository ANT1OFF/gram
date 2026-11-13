// Attachments, docs and outputs kept in an object store an embedding deployment configured
// (`GRAM_OBJECT_STORE_URL`), so they outlive the server's disk and that disk stays small.
//
// The data folder stays what everything reads and writes: nothing above this file changes how it
// stores a file. This mirrors it outward and reads back what is missing:
//
// - Every minute the attachments and docs folders are walked, and each file that is new or changed
//   since it was last sent is `PUT`. What was sent is remembered in a manifest beside them
//   (`object-store.json`), so a restart sends nothing twice.
// - A file a thread produced outside those folders (an output in its checkout) is copied up as it
//   is recorded (`put`).
// - A closed thread's objects are deleted with it. Nothing else deletes: a file missing here is
//   never taken as a reason to delete it there, since a fresh disk is missing all of them.
// - A server starting on a fresh disk (no manifest) lists the docs and brings them back before
//   anything reads them. An attachment is brought back when the transcript asks for it (`fetch`).
//
// The store is plain HTTP, with the bearer token on every call:
//
//   PUT    <url>/objects/<key>          the object's bytes
//   GET    <url>/objects/<key>          its bytes, or 404
//   GET    <url>/objects?prefix=<p>     { "keys": ["<key>", …] }, every key under the prefix
//   DELETE <url>/objects?prefix=<p>     deletes every key under the prefix
//
// Keys: `attachments/<threadId>/<file>`, `docs/<workspaceId>/<docId>.doc`,
// `outputs/<threadId>/<16 hex of the path's SHA-256>/<file name>`. The deployment may itself keep
// a thread's agent sessions under `sessions/<threadId>/`, so a thread whose machine is replaced
// resumes its conversation on the next one; Gram writes nothing there, and deletes that prefix with
// the thread, as it does its own.

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createHash, randomUUID } from "node:crypto";
import { openAsBlob, type Dirent } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ThreadId } from "@gram/contracts";
import { tryRealPath } from "@gram/git";
import { attachmentsDir } from "../attachments/attachments.ts";
import { ServerConfig } from "../config.ts";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import type { OutsideService } from "./config.ts";
import { Embedding } from "./embedding.ts";
import { callOutside } from "./outside.ts";

/** Where the deployment keeps a thread's agent sessions, by thread: deleted with the thread. */
export const SESSIONS_PREFIX = "sessions/";
/** The largest file sent or brought back; a larger one stays where it is. */
export const OBJECT_MAX_BYTES = 64 * 2 ** 20;
/** How often the mirrored folders are walked. */
const SWEEP_EVERY = "1 minute";
/** How many keys one listing may name; more is refused rather than half-restored. */
const LIST_MAX = 10_000;
const LIST_MAX_BYTES = 4 * 2 ** 20;
const MANIFEST = "object-store.json";
const NAME = "object store";

export interface ObjectStoreShape {
  /**
   * Copies the file at `real` (its real path, as it was checked) to `key`, soon and at most once
   * per change of the file. Nothing is sent if the file is no longer exactly there.
   */
  readonly put: (key: string, real: string) => Effect.Effect<void>;
  /**
   * Brings `key` back to `path` when the file isn't there. Whether it is there now. Never
   * overwrites, and never fails: a store that can't be reached reads as a file still missing.
   */
  readonly fetch: (key: string, path: string) => Effect.Effect<boolean>;
  /** One walk of the mirrored folders, now; the tests' way to wait for it. */
  readonly sweep: Effect.Effect<void>;
}

/** With no object store, or the hosted features off: nothing is sent and nothing is brought back. */
export const ObjectStore = Context.Reference<ObjectStoreShape>("@gram/server/ObjectStore", {
  defaultValue: () => ({
    put: () => Effect.void,
    fetch: () => Effect.succeed(false),
    sweep: Effect.void,
  }),
});

const objectPath = (key: string) => `/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
const prefixPath = (prefix: string) => `/objects?prefix=${encodeURIComponent(prefix)}`;

/** A key this server made: plain segments, none of them `.` or `..`, no leading slash. */
const KEY = /^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.@ -]+)+$/;
const safeKey = (key: string): boolean =>
  KEY.test(key) && key.split("/").every((segment) => segment !== "." && segment !== "..");

/** `attachments/<threadId>/<file>` for a file inside that thread's attachments folder. */
export const attachmentKey = (
  dataDir: string,
  threadId: ThreadId,
  path: string,
): string | undefined => {
  const root = join(attachmentsDir(dataDir), threadId) + sep;
  const at = resolve(path);
  if (!at.startsWith(root)) return undefined;
  const key = `attachments/${threadId}/${at.slice(root.length).split(sep).join("/")}`;
  return safeKey(key) ? key : undefined;
};

/** Where a thread's output outside its attachments is kept. */
export const outputKey = (threadId: ThreadId, path: string): string =>
  `outputs/${threadId}/${createHash("sha256").update(path).digest("hex").slice(0, 16)}/${
    basename(path).replaceAll(/[^A-Za-z0-9_.@ -]/g, "_") || "file"
  }`;

interface Manifest {
  /** Whether a fresh disk's docs were brought back, or there were none to bring. */
  restored: boolean;
  /** key → `<size>:<mtime>` of the file as it was last sent. */
  objects: Record<string, string>;
  /** Prefixes of closed threads the store hasn't confirmed deleting yet. */
  deletes: Array<string>;
}

const readManifest = async (file: string): Promise<Manifest | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Manifest>;
    if (typeof parsed.objects !== "object" || parsed.objects === null) return undefined;
    return {
      restored: parsed.restored === true,
      objects: { ...parsed.objects },
      deletes: Array.isArray(parsed.deletes)
        ? parsed.deletes.filter((each) => typeof each === "string")
        : [],
    };
  } catch {
    return undefined;
  }
};

/** A download in progress, beside where it will land; never sent, and swept away if abandoned. */
const PART = ".part";

/** Every plain file under `root` (no links followed), as `/`-joined paths below it. */
const walk = async (
  root: string,
  keep: (relative: string, entry: Dirent) => boolean,
): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  const visit = async (dir: string, below: string): Promise<void> => {
    const entries: Array<Dirent> = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = below === "" ? entry.name : `${below}/${entry.name}`;
      if (entry.name.endsWith(PART) || !keep(relative, entry)) continue;
      if (entry.isDirectory()) await visit(join(dir, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  await visit(root, "");
  return found;
};

/** The body's bytes, or `undefined` once it passes `max`: never more than `max` held at once. */
const readCapped = async (response: Response, max: number): Promise<Buffer | undefined> => {
  if (Number(response.headers.get("content-length") ?? "0") > max || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return response.body === null ? Buffer.alloc(0) : undefined;
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

const make = (service: OutsideService, dataDir: string, on: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const manifestFile = resolve(dataDir, MANIFEST);
    const loaded = yield* Effect.promise(() => readManifest(manifestFile));
    const manifest: Manifest = loaded ?? { restored: false, objects: {}, deletes: [] };
    let unsaved = false;
    // One writer at a time: the walk, the outputs and a restore all save through here.
    const saveLock = yield* Semaphore.make(1);
    const saveManifest = saveLock.withPermits(1)(
      Effect.promise(async () => {
        if (!unsaved) return;
        unsaved = false;
        try {
          await mkdir(dirname(manifestFile), { recursive: true });
          await writeFile(`${manifestFile}.tmp`, JSON.stringify(manifest));
          await rename(`${manifestFile}.tmp`, manifestFile);
        } catch {
          unsaved = true;
        }
      }),
    );

    /** Keys already said to be left out, so the log says so once each. */
    const skipped = new Set<string>();
    const skip = (key: string, why: string) =>
      skipped.has(key)
        ? Effect.void
        : Effect.sync(() => void skipped.add(key)).pipe(
            Effect.andThen(
              Effect.logWarning("a file is left out of the object store").pipe(
                Effect.annotateLogs({ key, why }),
              ),
            ),
          );

    /**
     * Sends the file when it is new or changed since it was last sent. `real` is where the file
     * was when it was judged fit to send: it is sent only while it is still exactly there, so a
     * folder swapped for a link in between sends nothing from wherever the link leads.
     */
    const send = (key: string, path: string, real: string) =>
      Effect.gen(function* () {
        if (!safeKey(key)) return yield* skip(key, "its name can't be a key");
        const info = yield* Effect.promise(() => lstat(path).catch(() => undefined));
        if (info === undefined || !info.isFile()) return;
        const stamp = `${info.size}:${Math.trunc(info.mtimeMs)}`;
        if (manifest.objects[key] === stamp) return;
        if (info.size > OBJECT_MAX_BYTES) return yield* skip(key, "over the size limit");
        if ((yield* Effect.promise(() => tryRealPath(path))) !== real) {
          return yield* skip(key, "it moved behind a link");
        }
        const body = yield* Effect.promise(() => openAsBlob(real));
        // The bytes opened are the file that was checked, not one put there since.
        if (body.size !== info.size) return;
        yield* callOutside(NAME, service, {
          method: "PUT",
          path: objectPath(key),
          body,
          timeoutMs: 120_000,
        });
        manifest.objects[key] = stamp;
        unsaved = true;
      }).pipe(
        Effect.catchCause((cause) =>
          // Sent again by the next walk, or the next time the output is recorded.
          Effect.logWarning("couldn't send a file to the object store").pipe(
            Effect.annotateLogs({ key, cause: Cause.pretty(cause) }),
          ),
        ),
      );

    const roots = [
      {
        prefix: "attachments",
        dir: attachmentsDir(dataDir),
        // Drafts are staging: their files are sent once a thread has them.
        keep: (relative: string) => !relative.startsWith("_"),
      },
      {
        prefix: "docs",
        dir: resolve(dataDir, "docs"),
        // A save is a temporary file renamed into place: only the records themselves.
        keep: (relative: string, entry: Dirent) => entry.isDirectory() || relative.endsWith(".doc"),
      },
    ];

    /** Asks the store to delete what `manifest.deletes` still lists; what fails stays listed. */
    const flushDeletes = Effect.gen(function* () {
      // The list as it stood: a confirmed delete replaces it rather than changing it underfoot.
      const listed = manifest.deletes;
      for (const prefix of listed) {
        const done = yield* callOutside(NAME, service, {
          method: "DELETE",
          path: prefixPath(prefix),
          accept: [404],
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("couldn't delete a thread's files from the object store").pipe(
              Effect.annotateLogs({ prefix, error: error.message }),
              Effect.as(false),
            ),
          ),
        );
        if (!done) continue;
        manifest.deletes = manifest.deletes.filter((each) => each !== prefix);
        unsaved = true;
      }
    });

    const sweepNow = Effect.gen(function* () {
      if (!(yield* on)) return;
      yield* flushDeletes;
      for (const root of roots) {
        const realRoot = yield* Effect.promise(() => tryRealPath(root.dir));
        if (realRoot === undefined) continue;
        const files = yield* Effect.promise(() => walk(root.dir, root.keep));
        for (const relative of files) {
          const below = relative.split("/");
          yield* send(
            `${root.prefix}/${relative}`,
            join(root.dir, ...below),
            join(realRoot, ...below),
          );
        }
      }
      yield* saveManifest;
    });
    // One walk at a time, whoever asked.
    const sweepLock = yield* Semaphore.make(1);
    const sweep = sweepLock.withPermits(1)(sweepNow);

    const download = (key: string, path: string) =>
      Effect.gen(function* () {
        const response = yield* callOutside(NAME, service, {
          method: "GET",
          path: objectPath(key),
          accept: [404],
          timeoutMs: 120_000,
        });
        if (response.status === 404) return false;
        const bytes = yield* Effect.promise(() => readCapped(response, OBJECT_MAX_BYTES));
        if (bytes === undefined) return false;
        // Whole before it has its name: written beside it, then linked into place, which fails
        // rather than replace whatever arrived here in the meantime.
        const part = `${path}.${randomUUID().slice(0, 8)}${PART}`;
        yield* Effect.promise(async () => {
          await mkdir(dirname(path), { recursive: true });
          try {
            await writeFile(part, bytes, { flag: "wx" });
            await link(part, path).catch(() => undefined);
          } finally {
            await rm(part, { force: true }).catch(() => undefined);
          }
        });
        const info = yield* Effect.promise(() => lstat(path).catch(() => undefined));
        if (info === undefined) return false;
        // As it came from the store: the next walk has nothing to send for it.
        manifest.objects[key] = `${info.size}:${Math.trunc(info.mtimeMs)}`;
        unsaved = true;
        return true;
      });

    const fetch: ObjectStoreShape["fetch"] = (key, path) =>
      Effect.gen(function* () {
        const there = yield* Effect.promise(() => lstat(path).catch(() => undefined));
        if (there !== undefined) return true;
        if (!safeKey(key) || !(yield* on)) return false;
        return yield* download(key, path);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't bring a file back from the object store").pipe(
            Effect.annotateLogs({ key, cause: Cause.pretty(cause) }),
            Effect.as(false),
          ),
        ),
      );

    /**
     * A fresh disk's docs, before anything lists them. Counted done only when every one of them
     * came back; otherwise the next start asks again for the ones still missing.
     */
    const restoreDocs = Effect.gen(function* () {
      if (manifest.restored || !(yield* on)) return;
      const response = yield* callOutside(NAME, service, {
        method: "GET",
        path: prefixPath("docs/"),
      });
      const text = yield* Effect.promise(() => readCapped(response, LIST_MAX_BYTES));
      let keys: unknown;
      try {
        keys = (JSON.parse(text?.toString("utf8") ?? "") as { readonly keys?: unknown }).keys;
      } catch {
        keys = undefined;
      }
      if (!Array.isArray(keys) || keys.length > LIST_MAX) {
        return yield* Effect.fail("the listing isn't a list of keys");
      }
      const docs = resolve(dataDir, "docs");
      let restored = 0;
      let missed = 0;
      for (const key of keys) {
        if (typeof key !== "string" || !safeKey(key)) continue;
        const [prefix, workspace, record, ...rest] = key.split("/");
        if (prefix !== "docs" || rest.length > 0 || !record!.endsWith(".doc")) continue;
        const path = join(docs, workspace!, record!);
        if ((yield* Effect.promise(() => lstat(path).catch(() => undefined))) !== undefined)
          continue;
        const came = yield* download(key, path).pipe(Effect.catch(() => Effect.succeed(false)));
        if (came) restored += 1;
        else missed += 1;
      }
      if (missed === 0) {
        manifest.restored = true;
        unsaved = true;
      }
      yield* saveManifest;
      if (restored > 0 || missed > 0) {
        yield* Effect.logInfo("docs restored from the object store", { restored, missed });
      }
    }).pipe(
      // Start waits on this, so not for long: what didn't come is asked for at the next start.
      Effect.timeout("30 seconds"),
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't restore docs from the object store").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
    );

    /**
     * A closed thread's objects. Listed in the manifest before the store is asked, so a store that
     * is down, or a server stopped first, still has them deleted by a later walk.
     */
    const removeUnder = (prefix: string) =>
      Effect.gen(function* () {
        if (!(yield* on)) return;
        for (const key of Object.keys(manifest.objects)) {
          if (key.startsWith(prefix)) delete manifest.objects[key];
        }
        if (!manifest.deletes.includes(prefix)) manifest.deletes.push(prefix);
        unsaved = true;
        yield* saveManifest;
        yield* flushDeletes;
        yield* saveManifest;
      });

    // Outputs go one at a time, off the caller's fiber.
    const pending = yield* Queue.unbounded<readonly [string, string]>();
    yield* Queue.take(pending).pipe(
      Effect.flatMap(([key, real]) =>
        Effect.gen(function* () {
          if (!(yield* on)) return;
          // Not a thread closed since: its outputs were deleted, and this would put one back.
          if (manifest.deletes.some((prefix) => key.startsWith(prefix))) return;
          yield* send(key, real, real);
          yield* saveManifest;
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("sending an output to the object store failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return {
      sweep,
      fetch,
      restoreDocs,
      removeUnder,
      put: (key: string, real: string) => Queue.offer(pending, [key, real]).pipe(Effect.asVoid),
    };
  });

/** The store an embedding deployment configured; without one, `ObjectStore`'s default stands. */
export const ObjectStoreLive = Layer.unwrap(
  Effect.gen(function* () {
    const embedding = yield* Embedding;
    const service = embedding.config.objectStore;
    if (service === undefined) return Layer.empty;
    const config = yield* ServerConfig;
    const hub = yield* EventHub;
    return Layer.effect(
      ObjectStore,
      Effect.gen(function* () {
        const store = yield* make(service, config.dataDir, embedding.on);
        yield* store.restoreDocs;
        yield* Effect.sleep(SWEEP_EVERY).pipe(
          Effect.andThen(store.sweep),
          Effect.catchCause((cause) =>
            Effect.logWarning("object store walk failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* hub.internalEvents(isThreadRemoved, "object store cleanup").pipe(
          Stream.runForEach((event) =>
            Effect.andThen(
              store.removeUnder(`attachments/${event.threadId}/`),
              Effect.andThen(
                store.removeUnder(`outputs/${event.threadId}/`),
                store.removeUnder(`${SESSIONS_PREFIX}${event.threadId}/`),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        return { put: store.put, fetch: store.fetch, sweep: store.sweep };
      }),
    );
  }),
);
