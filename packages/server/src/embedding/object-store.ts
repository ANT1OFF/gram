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
import { bytesOf } from "../shared/bytes.ts";
import { callOutside } from "./outside.ts";

/** Where the deployment keeps a thread's agent sessions, by thread: deleted with the thread. */
export const SESSIONS_PREFIX = "sessions/";
/** The largest file sent or brought back; a larger one stays where it is. */
export const OBJECT_MAX_BYTES = 64 * 2 ** 20;
const SWEEP_EVERY = "1 minute";
const LIST_MAX = 10_000;
const LIST_MAX_BYTES = 4 * 2 ** 20;
const MANIFEST = "object-store.json";
const STAGING = "object-store-staging";
const NAME = "object store";

export interface ObjectStoreShape {
  /**
   * Copies the file at `real` (its real path, as it was checked) to `key`, soon and at most once
   * per change of the file. Nothing is sent if the file is no longer exactly there.
   */
  readonly put: (key: string, real: string) => Effect.Effect<void>;
  /** Whether anything is sent now: a store is configured and the hosted features are on. */
  readonly on: Effect.Effect<boolean>;
  /**
   * Copies a file this server can't read where it is to `key`, soon and at most once per `stamp`
   * (`<size>:<mtime>` of the file where it is). `stage` is asked to write the file's bytes at a
   * path of this server's own and to say whether it did; that copy is sent, then removed. Nothing
   * is asked of `stage` for a stamp already sent, with the store off, or for a closed thread.
   */
  readonly putStaged: (
    key: string,
    stamp: string,
    stage: (path: string) => Effect.Effect<boolean>,
  ) => Effect.Effect<void>;
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
    on: Effect.succeed(false),
    putStaged: () => Effect.void,
    fetch: () => Effect.succeed(false),
    sweep: Effect.void,
  }),
});

const STAGED_RETRY_AFTER_MS = 5 * 60_000;
const STAGED_TRIES_AT_ONCE = 2;

const objectPath = (key: string) => `/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
const prefixPath = (prefix: string) => `/objects?prefix=${encodeURIComponent(prefix)}`;

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
  restored: boolean;
  objects: Record<string, string>;
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

const PART = ".part";

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

const readCapped = async (response: Response, max: number): Promise<Buffer | undefined> => {
  if (Number(response.headers.get("content-length") ?? "0") > max || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return response.body === null ? Buffer.alloc(0) : undefined;
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for await (const value of bytesOf(response.body)) {
    size += value.byteLength;
    if (size > max) return undefined;
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
          Effect.logWarning("couldn't send a file to the object store").pipe(
            Effect.annotateLogs({ key, cause: Cause.pretty(cause) }),
          ),
        ),
      );

    const roots = [
      {
        prefix: "attachments",
        dir: attachmentsDir(dataDir),
        keep: (relative: string) => !relative.startsWith("_"),
      },
      {
        prefix: "docs",
        dir: resolve(dataDir, "docs"),
        keep: (relative: string, entry: Dirent) => entry.isDirectory() || relative.endsWith(".doc"),
      },
    ];

    const flushDeletes = Effect.gen(function* () {
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
      Effect.timeout("30 seconds"),
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't restore docs from the object store").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
    );

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

    const stagingDir = resolve(dataDir, STAGING);
    const failedStaged = new Map<
      string,
      { readonly stamp: string; readonly at: number; readonly tries: number }
    >();
    const sendStaged = (
      key: string,
      stamp: string,
      stage: (path: string) => Effect.Effect<boolean>,
    ) =>
      Effect.gen(function* () {
        if (!safeKey(key)) return yield* skip(key, "its name can't be a key");
        if (manifest.objects[key] === stamp) return;
        const before = failedStaged.get(key);
        const tries = before?.stamp === stamp ? before.tries : 0;
        if (
          before !== undefined &&
          tries >= STAGED_TRIES_AT_ONCE &&
          Date.now() - before.at < STAGED_RETRY_AFTER_MS
        )
          return;
        failedStaged.set(key, { stamp, at: Date.now(), tries: tries + 1 });
        const path = join(stagingDir, `${randomUUID()}${PART}`);
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => mkdir(stagingDir, { recursive: true }));
          if (!(yield* stage(path))) return;
          const info = yield* Effect.promise(() => lstat(path).catch(() => undefined));
          if (info === undefined || !info.isFile()) return;
          if (info.size > OBJECT_MAX_BYTES) return yield* skip(key, "over the size limit");
          const body = yield* Effect.promise(() => openAsBlob(path));
          yield* callOutside(NAME, service, {
            method: "PUT",
            path: objectPath(key),
            body,
            timeoutMs: 120_000,
          });
          manifest.objects[key] = stamp;
          unsaved = true;
          failedStaged.delete(key);
        }).pipe(
          Effect.ensuring(Effect.promise(() => rm(path, { force: true }).catch(() => undefined))),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't send another machine's file to the object store").pipe(
            Effect.annotateLogs({ key, cause: Cause.pretty(cause) }),
          ),
        ),
      );
    yield* Effect.promise(() =>
      rm(stagingDir, { recursive: true, force: true }).catch(() => undefined),
    );

    type Output =
      | { readonly key: string; readonly real: string }
      | {
          readonly key: string;
          readonly stamp: string;
          readonly stage: (path: string) => Effect.Effect<boolean>;
        };
    const pending = yield* Queue.unbounded<Output>();
    yield* Queue.take(pending).pipe(
      Effect.flatMap((output) =>
        Effect.gen(function* () {
          if (!(yield* on)) return;
          if (manifest.deletes.some((prefix) => output.key.startsWith(prefix))) return;
          if ("stage" in output) yield* sendStaged(output.key, output.stamp, output.stage);
          else yield* send(output.key, output.real, output.real);
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
      on,
      put: (key: string, real: string) => Queue.offer(pending, { key, real }).pipe(Effect.asVoid),
      putStaged: (key: string, stamp: string, stage: (path: string) => Effect.Effect<boolean>) =>
        Queue.offer(pending, { key, stamp, stage }).pipe(Effect.asVoid),
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
        return {
          put: store.put,
          on: store.on,
          putStaged: store.putStaged,
          fetch: store.fetch,
          sweep: store.sweep,
        };
      }),
    );
  }),
);
