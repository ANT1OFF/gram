import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { existsSync, readdirSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { Embedding } from "./embedding.ts";
import { attachmentKey, ObjectStore, ObjectStoreLive, outputKey } from "./object-store.ts";

const TOKEN = "object-store-token-0123456789abcdef";

interface Bucket {
  readonly server: Server;
  readonly url: string;
  readonly objects: Map<string, Buffer>;
  /** Each call as `METHOD path`, in order. */
  readonly calls: Array<string>;
  readonly auths: Set<string | undefined>;
  status: number | undefined;
}

/** An object store kept in memory, speaking the calls the server makes. */
const bucket = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<Bucket>((resolve) => {
        const objects = new Map<string, Buffer>();
        const calls: Array<string> = [];
        const auths = new Set<string | undefined>();
        const server = createServer((req, res) => {
          const chunks: Array<Buffer> = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const url = new URL(req.url ?? "", "http://store");
            calls.push(`${req.method} ${req.url}`);
            auths.add(req.headers.authorization);
            if (state.status !== undefined) return void res.writeHead(state.status).end();
            const prefix = url.searchParams.get("prefix");
            const key = decodeURIComponent(url.pathname.replace("/v1/objects/", ""));
            if (prefix !== null) {
              const keys = [...objects.keys()].filter((each) => each.startsWith(prefix));
              if (req.method === "DELETE") for (const each of keys) objects.delete(each);
              return void res
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ keys }));
            }
            if (req.method === "PUT") {
              objects.set(key, Buffer.concat(chunks));
              return void res.writeHead(204).end();
            }
            const found = objects.get(key);
            if (found === undefined) return void res.writeHead(404).end();
            res.writeHead(200).end(found);
          });
        });
        const state: Bucket = {
          server,
          url: "",
          objects,
          calls,
          auths,
          status: undefined,
        };
        server.listen(0, "127.0.0.1", () =>
          resolve(
            Object.assign(state, {
              url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            }),
          ),
        );
      }),
  ),
  ({ server }) => Effect.promise(() => new Promise((resolve) => server.close(resolve))),
);

const dataDir = Effect.acquireRelease(
  // Its real path: a temp folder is reached through a link on some systems.
  Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "gram-objects-")))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

const put = (path: string, text: string) =>
  Effect.promise(async () => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  });

/** A server's object store over `dir`, for as long as `use` runs. */
const withStore = <A, E>(
  dir: string,
  options: { readonly url?: string; readonly on?: boolean },
  use: (
    store: (typeof ObjectStore)["Service"],
    hub: EventHub["Service"],
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* ObjectStore, yield* EventHub);
  }).pipe(
    Effect.provide(
      ObjectStoreLive.pipe(
        Layer.provideMerge(EventHub.layer),
        Layer.provide(
          Embedding.layerOf(
            options.url === undefined ? {} : { objectStore: { url: options.url, token: TOKEN } },
            Effect.succeed(options.on ?? true),
          ),
        ),
        Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir: dir })),
      ),
    ),
    Effect.scoped,
  );

const eventually = (what: string, check: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 100; tries++) {
      if (check()) return;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(`never: ${what}`);
  });

const T1 = "thread-1" as ThreadId;

describe("ObjectStore", () => {
  it.live("sends nothing with no store configured, or with the hosted features off", () =>
    Effect.gen(function* () {
      const store = yield* bucket;
      const dir = yield* dataDir;
      const file = join(dir, "attachments", T1, "a.txt");
      yield* put(file, "a");
      for (const options of [{}, { url: store.url, on: false }]) {
        yield* withStore(dir, options, (objects) =>
          Effect.gen(function* () {
            yield* objects.sweep;
            yield* objects.put(outputKey(T1, "/work/out.png"), file);
            expect(yield* objects.fetch("attachments/thread-1/gone.txt", join(dir, "gone"))).toBe(
              false,
            );
            yield* Effect.sleep("100 millis");
          }),
        );
      }
      expect(store.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("sends each attachment and doc once per change, and never a draft's", () =>
    Effect.gen(function* () {
      const store = yield* bucket;
      const dir = yield* dataDir;
      const file = join(dir, "attachments", T1, "1a2b-shot.png");
      yield* put(file, "first");
      yield* put(join(dir, "attachments", "_drafts", "d1", "draft.txt"), "staged");
      yield* put(join(dir, "docs", "ws-1", "plan-0a1b2c.doc"), "{}\n# Plan");
      yield* put(join(dir, "docs", "ws-1", "plan-0a1b2c.doc.tmp"), "half");

      yield* withStore(dir, { url: store.url }, (objects) =>
        Effect.gen(function* () {
          yield* objects.sweep;
          expect([...store.objects.keys()].toSorted()).toEqual([
            "attachments/thread-1/1a2b-shot.png",
            "docs/ws-1/plan-0a1b2c.doc",
          ]);
          expect(store.auths).toEqual(new Set([`Bearer ${TOKEN}`]));
          const sent = store.calls.length;
          yield* objects.sweep;
          expect(store.calls.length).toBe(sent);

          yield* put(file, "second, longer");
          yield* objects.sweep;
          expect(store.objects.get("attachments/thread-1/1a2b-shot.png")?.toString()).toBe(
            "second, longer",
          );
        }),
      );
      // What was sent is remembered through a restart.
      const sent = store.calls.length;
      yield* withStore(dir, { url: store.url }, (objects) => objects.sweep);
      expect(store.calls.length).toBe(sent);
    }).pipe(Effect.scoped),
  );

  it.live("sends a failed file again, and deletes a closed thread's objects", () =>
    Effect.gen(function* () {
      const store = yield* bucket;
      const dir = yield* dataDir;
      const file = join(dir, "attachments", T1, "a.txt");
      const output = join(dir, "checkout", "report.pdf");
      yield* put(file, "a");
      yield* put(output, "pdf");
      yield* put(join(dir, "attachments", "thread-2", "b.txt"), "b");

      yield* withStore(dir, { url: store.url }, (objects, hub) =>
        Effect.gen(function* () {
          store.status = 503;
          yield* objects.sweep;
          expect(store.objects.size).toBe(0);
          store.status = undefined;
          yield* objects.sweep;
          yield* objects.put(outputKey(T1, output), output);
          yield* eventually("the output sent", () => store.objects.size === 3);
          expect(
            [...store.objects.keys()].some((key) =>
              /^outputs\/thread-1\/[0-9a-f]{16}\/report\.pdf$/.test(key),
            ),
          ).toBe(true);

          // What the deployment keeps of each thread's agent sessions goes with its thread too.
          store.objects.set(`sessions/${T1}/claude/s.jsonl`, Buffer.from("{}"));
          store.objects.set("sessions/thread-2/claude/s.jsonl", Buffer.from("{}"));

          yield* hub.publish({ type: "thread.removed", threadId: T1 });
          yield* eventually("the thread's objects deleted", () => store.objects.size === 2);
          expect([...store.objects.keys()].toSorted()).toEqual([
            "attachments/thread-2/b.txt",
            "sessions/thread-2/claude/s.jsonl",
          ]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("sends a file staged from another machine once per stamp, and keeps no copy", () =>
    Effect.gen(function* () {
      const store = yield* bucket;
      const dir = yield* dataDir;
      const key = outputKey(T1, "/work/repo/report.pdf");
      let staged = 0;
      const stage = (text: string) => (path: string) =>
        Effect.promise(async () => {
          staged += 1;
          await writeFile(path, text);
          return true;
        });

      yield* withStore(dir, { url: store.url }, (objects, hub) =>
        Effect.gen(function* () {
          expect(yield* objects.on).toBe(true);
          yield* objects.putStaged(key, "3:1000", stage("pdf"));
          yield* eventually("the staged output sent", () => store.objects.size === 1);
          expect(store.objects.get(key)?.toString()).toBe("pdf");
          // The same stamp again asks for nothing; a new one sends the file again.
          yield* objects.putStaged(key, "3:1000", stage("pdf"));
          yield* objects.putStaged(key, "4:2000", stage("pdf2"));
          yield* eventually("the change sent", () => store.objects.get(key)?.toString() === "pdf2");
          expect(staged).toBe(2);
          // One that couldn't be read sends nothing, and one the store refused is asked again.
          yield* objects.putStaged(key, "5:3000", () => Effect.succeed(false));
          store.status = 503;
          yield* objects.putStaged(key, "6:4000", stage("pdf-33"));
          yield* eventually("the refused send tried", () => staged === 3);
          store.status = undefined;
          yield* objects.putStaged(key, "6:4000", stage("pdf-33"));
          yield* eventually(
            "the refused one sent",
            () => store.objects.get(key)?.toString() === "pdf-33",
          );
          expect(staged).toBe(4);
          yield* eventually(
            "the staged copies removed",
            () => readdirSync(join(dir, "object-store-staging")).length === 0,
          );
          // Deleted with its thread, as an output copied from this disk is.
          yield* hub.publish({ type: "thread.removed", threadId: T1 });
          yield* eventually("the thread's objects deleted", () => store.objects.size === 0);
        }),
      );
      // Nothing is asked with the hosted features off.
      yield* withStore(dir, { url: store.url, on: false }, (objects) =>
        Effect.gen(function* () {
          expect(yield* objects.on).toBe(false);
          yield* objects.putStaged(key, "9:9000", stage("late"));
          yield* Effect.sleep("100 millis");
        }),
      );
      expect(staged).toBe(4);
      expect(store.objects.size).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("sends nothing from behind a link put there after the file was checked", () =>
    Effect.gen(function* () {
      const store = yield* bucket;
      const dir = yield* dataDir;
      const output = join(dir, "checkout", "out", "report.txt");
      yield* put(output, "mine");
      yield* put(join(dir, "elsewhere", "report.txt"), "not the thread's");
      yield* put(join(dir, "attachments", T1, "sub", "a.txt"), "mine too");

      yield* withStore(dir, { url: store.url }, (objects) =>
        Effect.gen(function* () {
          // The folders are swapped for links after the paths were judged.
          yield* Effect.promise(async () => {
            await rename(join(dir, "checkout", "out"), join(dir, "checkout", "was"));
            await symlink(join(dir, "elsewhere"), join(dir, "checkout", "out"));
            await rm(join(dir, "attachments", T1, "sub"), { recursive: true });
            await symlink(join(dir, "elsewhere"), join(dir, "attachments", T1, "sub"));
          });
          yield* objects.put(outputKey(T1, output), output);
          yield* objects.sweep;
          yield* Effect.sleep("200 millis");
          expect([...store.objects.keys()]).toEqual([]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("deletes a closed thread's objects later when the store was down", () =>
    Effect.gen(function* () {
      const store = yield* bucket;
      const dir = yield* dataDir;
      yield* put(join(dir, "attachments", T1, "a.txt"), "a");
      yield* withStore(dir, { url: store.url }, (objects, hub) =>
        Effect.gen(function* () {
          yield* objects.sweep;
          expect(store.objects.size).toBe(1);
          store.status = 503;
          yield* hub.publish({ type: "thread.removed", threadId: T1 });
          yield* eventually("the delete tried", () =>
            store.calls.some((call) => call.startsWith("DELETE")),
          );
          yield* Effect.promise(() => rm(join(dir, "attachments", T1), { recursive: true }));
        }),
      );
      // Through a restart: the next walk asks again.
      store.status = undefined;
      yield* withStore(dir, { url: store.url }, (objects) => objects.sweep);
      expect(store.objects.size).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("brings docs back to a fresh disk at start, and an attachment when asked", () =>
    Effect.gen(function* () {
      const store = yield* bucket;
      const dir = yield* dataDir;
      store.objects.set("docs/ws-1/plan-0a1b2c.doc", Buffer.from("{}\n# Plan"));
      store.objects.set("docs/../../escape.doc", Buffer.from("no"));
      store.objects.set("attachments/thread-1/a.txt", Buffer.from("kept"));

      yield* withStore(dir, { url: store.url }, (objects) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.promise(() =>
              readFile(join(dir, "docs", "ws-1", "plan-0a1b2c.doc"), "utf8"),
            ),
          ).toBe("{}\n# Plan");
          expect(existsSync(join(dir, "..", "escape.doc"))).toBe(false);

          const path = join(dir, "attachments", T1, "a.txt");
          expect(existsSync(path)).toBe(false);
          const key = attachmentKey(dir, T1, path)!;
          expect(key).toBe("attachments/thread-1/a.txt");
          expect(yield* objects.fetch(key, path)).toBe(true);
          expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe("kept");
          expect(yield* objects.fetch("attachments/thread-1/none.txt", join(dir, "none"))).toBe(
            false,
          );
          // Nothing that came from the store is sent back to it.
          yield* objects.sweep;
          expect(store.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
        }),
      );
      // Restored once: the next start doesn't list again.
      const lists = () => store.calls.filter((call) => call.includes("?prefix=docs")).length;
      expect(lists()).toBe(1);
      yield* withStore(dir, { url: store.url }, () => Effect.void);
      expect(lists()).toBe(1);
      expect(attachmentKey(dir, T1, join(dir, "attachments", "thread-2", "b.txt"))).toBeUndefined();
      expect(attachmentKey(dir, T1, join(dir, "attachments", T1, "..", "x"))).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
