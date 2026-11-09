import { describe, expect, it } from "@effect/vitest";
import {
  type FileImage,
  type FsFile,
  HostId,
  HostUnavailable,
  InvalidState,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPlatformTest } from "../../git/platform.ts";
import type { HostFileReads, OutsideAllowed } from "../../host/file-reads.ts";
import type { HostFiles } from "../../host/files.ts";
import { WorkerHosts, type WorkerHost } from "../../host/worker-host.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { makeRuntimeTestLayer } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { editorHandlers } from "./editor.ts";
import { fsHandlers } from "./fs.ts";

const TestLayer = Layer.merge(makeRuntimeTestLayer(), gitPlatformTest());

const MACHINE = HostId.make("box");
const MAIN_CONTENT = "MAIN MACHINE CONTENT";
const REMOTE_CONTENT = "synthetic content on the joined machine";

/** What the joined machine's host was asked, in order. */
type Call = { readonly call: string; readonly path: string; readonly outside?: OutsideAllowed };

/**
 * A joined machine whose reads answer from its own (synthetic) disk and record what they were
 * asked; with `reads: false`, a host from a build that can't read files.
 */
const machineHost = (calls: Array<Call>, options: { readonly reads?: boolean } = {}) => {
  const file = (path: string, outside: OutsideAllowed): FsFile => {
    calls.push({ call: "file", path, outside });
    return {
      path,
      size: REMOTE_CONTENT.length,
      binary: false,
      tooLarge: false,
      content: REMOTE_CONTENT,
    };
  };
  const reads: HostFileReads = {
    scope: (path, roots) =>
      Effect.sync(() => {
        calls.push({ call: "scope", path });
        return path === "." ? roots[0]! : join(roots[0]!, path);
      }),
    file: (path, _roots, outside) => Effect.sync(() => file(path, outside)),
    image: (path, _roots, outside) =>
      Effect.sync((): FileImage => {
        calls.push({ call: "image", path, outside });
        return { path, mediaType: "image/png", size: 3, tooLarge: false, base64: "cG5n" };
      }),
    resolve: (paths, _roots, outside) =>
      Effect.sync(() => {
        calls.push({ call: "resolve", path: paths.join(",") });
        return {
          files: paths
            .filter((path) => !path.startsWith("/elsewhere") || outside.includes(path))
            .map((path) => ({ path, resolved: path })),
          unchecked: paths.filter(
            (path) => path.startsWith("/elsewhere") && !outside.includes(path),
          ),
        };
      }),
    vocabulary: () =>
      Effect.sync(() => {
        calls.push({ call: "vocabulary", path: "" });
        return { symbols: ["remoteSymbol"], files: [], branches: [] };
      }),
    fetch: () => Effect.die("not used here"),
  };
  const files: HostFiles = {
    list: (path) =>
      Effect.sync(() => {
        calls.push({ call: "list", path });
        return { path, entries: [], truncated: false };
      }),
    search: (root) =>
      Effect.sync(() => {
        calls.push({ call: "search", path: root });
        return { matches: [], truncated: false, total: 0 } as never;
      }),
    names: (root) =>
      Effect.sync(() => {
        calls.push({ call: "names", path: root });
        return { entries: [], truncated: false } as never;
      }),
  };
  return (local: WorkerHost): WorkerHost => ({
    ...local,
    id: MACHINE,
    name: "box",
    files,
    reads: options.reads === false ? undefined : reads,
  });
};

/**
 * A thread placed on the joined machine whose recorded checkout path also exists on this one,
 * holding a file of the same name: what this machine reads there is never the thread's.
 */
const remoteThread = Effect.gen(function* () {
  const here = realpathSync(mkdtempSync(join(tmpdir(), "gram-coincident-")));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(here, { recursive: true })));
  writeFileSync(join(here, "report.txt"), MAIN_CONTENT);
  const runtimes = yield* ThreadRuntimes;
  const store = yield* ThreadStore;
  const created = yield* runtimes.create({
    deferOpen: true,
    projectRoot: here,
    checkout: { kind: "main", path: here },
  });
  const thread = yield* store.insertThread({
    ...created,
    checkout: { kind: "worktree", path: here, branch: "work", hostId: MACHINE },
  });
  return { here, threadId: thread.id as ThreadId };
});

/** `fsHandlers` over a `WorkerHosts` with the joined machine, online or not. */
const handlersWith = (calls: Array<Call>, options: { reads?: boolean; offline?: boolean } = {}) =>
  Effect.gen(function* () {
    const local = (yield* WorkerHosts).local;
    const hosts = WorkerHosts.fromHosts(
      local,
      options.offline ? [] : [machineHost(calls, options)(local)],
      (id) => Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
    );
    return yield* Effect.provideService(fsHandlers, WorkerHosts, hosts);
  });

describe("a joined machine's thread's files", () => {
  it.effect("are read on that machine, never at the same path on this one", () =>
    Effect.gen(function* () {
      const { here, threadId } = yield* remoteThread;
      const calls: Array<Call> = [];
      const handlers = yield* handlersWith(calls);
      // Before this change this returned MAIN MACHINE CONTENT, read from this disk.
      const file = yield* handlers["fs.file"]({ path: "report.txt", threadId });
      expect(file.content).toBe(REMOTE_CONTENT);
      // Relative, so never outside the folders: the transcript isn't asked.
      expect(calls).toEqual([
        {
          call: "file",
          path: "report.txt",
          outside: { allowed: false, refusal: expect.any(String) },
        },
      ]);

      const image = yield* handlers["fs.image"]({ path: join(here, "shot.png"), threadId });
      expect(image.base64).toBe("cG5n");
      const markdown = yield* handlers["fs.preview"]({ path: "notes.md", threadId });
      expect(markdown).toEqual({ kind: "markdown", path: "notes.md", content: REMOTE_CONTENT });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("list, search and names scope the path on that machine", () =>
    Effect.gen(function* () {
      const { here, threadId } = yield* remoteThread;
      const calls: Array<Call> = [];
      const handlers = yield* handlersWith(calls);
      yield* handlers["fs.list"]({ path: "src", threadId });
      yield* handlers["fs.search"]({ threadId, query: "x" });
      yield* handlers["fs.files"]({ threadId });
      expect(calls.map(({ call, path }) => `${call} ${path}`)).toEqual([
        "scope src",
        `list ${join(here, "src")}`,
        "scope .",
        `search ${here}`,
        "scope .",
        `names ${here}`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("ask the transcript about a path outside the folders, and let the host check it", () =>
    Effect.gen(function* () {
      const { threadId } = yield* remoteThread;
      const calls: Array<Call> = [];
      const handlers = yield* handlersWith(calls);
      yield* handlers["fs.file"]({ path: "/elsewhere/notes.txt", threadId });
      // Nothing in the transcript names it, so the host is told it isn't allowed.
      expect(calls.at(-1)?.outside?.allowed).toBe(false);
      const resolved = yield* handlers["fs.resolve"]({
        threadId,
        paths: ["src/a.ts", "/elsewhere/b.ts"],
      });
      expect(resolved.files).toEqual([{ path: "src/a.ts", resolved: "src/a.ts" }]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("are refused, naming the machine, when its host can't read them", () =>
    Effect.gen(function* () {
      const { threadId } = yield* remoteThread;
      const calls: Array<Call> = [];
      const old = yield* handlersWith(calls, { reads: false });
      const refused = yield* old["fs.file"]({ path: "report.txt", threadId }).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(InvalidState);
      expect(refused.message).toContain("gram-host on box is older");
      expect(refused.message).not.toContain(MAIN_CONTENT);
      const listing = yield* old["fs.list"]({ path: ".", threadId }).pipe(Effect.flip);
      expect(listing.message).toContain("gram-host on box is older");

      const offline = yield* handlersWith(calls, { offline: true });
      const away = yield* offline["fs.file"]({ path: "report.txt", threadId }).pipe(Effect.flip);
      expect(away.message).toContain("can't be reached now");
      // Dictation keeps the thread titles while the machine is away.
      const vocabulary = yield* offline["fs.vocabulary"]({ threadId });
      expect(vocabulary.terms.some((term) => term.kind === "symbol")).toBe(false);
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuse an HTML preview, and opening one in an editor here", () =>
    Effect.gen(function* () {
      const { threadId } = yield* remoteThread;
      const handlers = yield* handlersWith([]);
      const html = yield* handlers["fs.preview"]({ path: "index.html", threadId }).pipe(
        Effect.flip,
      );
      expect(html.message).toContain("can't preview HTML from box");
      const editor = yield* editorHandlers;
      const opened = yield* editor["editor.open"]({ path: "report.txt", threadId }).pipe(
        Effect.flip,
      );
      expect(opened.message).toContain(
        "Gram opens files in an editor or file manager only on this machine",
      );
      const revealed = yield* editor["fs.reveal"]({ path: "report.txt", threadId }).pipe(
        Effect.flip,
      );
      expect(revealed).toBeInstanceOf(InvalidState);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("read the vocabulary where the checkout is", () =>
    Effect.gen(function* () {
      const { threadId } = yield* remoteThread;
      const calls: Array<Call> = [];
      const handlers = yield* handlersWith(calls);
      const vocabulary = yield* handlers["fs.vocabulary"]({ threadId });
      expect(vocabulary.terms).toContainEqual({ term: "remoteSymbol", kind: "symbol" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
