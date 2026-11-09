import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  ThreadNotFound,
  type GramUIMessageChunk,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileReadsOn } from "../host/file-reads.ts";
import { ProcLive, Proc } from "@gram/git";
import { bindAppTools } from "./registry.ts";
import { sendFileTool, type SentFromMachines, sentMediaType } from "./file-tools.ts";

const THREAD = "t-files" as ThreadId;

/** A checkout with a report in it and a screenshot outside it, as an agent typically leaves them. */
const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-send-file-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const checkout = join(dir, "repo");
  mkdirSync(join(checkout, "docs"), { recursive: true });
  writeFileSync(join(checkout, "docs", "report.md"), "# Report\n");
  const shot = join(dir, "shot.png");
  writeFileSync(shot, "png");

  const chunks: Array<GramUIMessageChunk> = [];
  const [tool] = bindAppTools(
    [
      sendFileTool(
        {
          emitChunk: (_threadId, chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
              return "m-1" as never;
            }),
        },
        {
          getThread: (threadId) =>
            threadId === THREAD
              ? Effect.succeed({
                  id: THREAD,
                  checkout: { kind: "main", path: checkout },
                } as unknown as Thread)
              : Effect.fail(new ThreadNotFound({ threadId })),
        },
      ),
    ],
    THREAD,
  );
  return { checkout, shot, chunks, tool: tool! };
});

describe("send_file", () => {
  it.effect(
    "attaches files to the reply, from the checkout by relative path or from anywhere",
    () =>
      Effect.gen(function* () {
        const { checkout, shot, chunks, tool } = yield* setup;
        expect(tool.descriptor.class).toBe("self");
        const report = join(checkout, "docs", "report.md");
        expect(yield* tool.run({ files: ["docs/report.md", shot] })).toEqual({
          sent: [
            { path: report, size: 9, mediaType: "text/markdown" },
            { path: shot, size: 3, mediaType: "image/png" },
          ],
        });
        expect(chunks).toEqual([
          { type: "file", url: pathToFileURL(report).href, mediaType: "text/markdown" },
          { type: "file", url: pathToFileURL(shot).href, mediaType: "image/png" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("shows nothing when any path is missing or a folder", () =>
    Effect.gen(function* () {
      const { chunks, tool } = yield* setup;
      for (const files of [["docs/report.md", "docs/nope.md"], ["docs"], []]) {
        expect(yield* Effect.flip(tool.run({ files }))).toBeInstanceOf(AppToolError);
      }
      expect(chunks).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it("types images and common documents, and falls back to bytes", () => {
    expect(sentMediaType("/a/Shot.PNG")).toBe("image/png");
    expect(sentMediaType("/a/report.pdf")).toBe("application/pdf");
    expect(sentMediaType("/a/archive.tar.zst")).toBe("application/octet-stream");
  });
});

/**
 * A thread on a joined machine whose checkout path also exists here with a file of the same name,
 * and the machine's own folder (another temp folder, standing in for its disk) behind its reads.
 */
const onMachine = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-send-file-machine-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  // This machine's file at the thread's recorded path, which must never be the one sent.
  const checkout = join(dir, "here", "repo");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "report.md"), "MAIN MACHINE CONTENT");
  // The machine's own checkout, where its reads look for the same names.
  const there = join(dir, "there", "repo");
  mkdirSync(there, { recursive: true });
  writeFileSync(join(there, "report.md"), "# Synthetic remote report\n");
  const attachments = join(dir, "attachments");
  const reads = fileReadsOn(yield* Proc);
  const machines: SentFromMachines = {
    dir: attachments,
    readsFor: () =>
      Effect.succeed({
        name: "box",
        // The machine's disk: the thread's path is its folder there.
        reads: {
          ...reads,
          fetch: (path, cwd, maxBytes) =>
            reads.fetch(path, cwd === checkout ? there : cwd, maxBytes),
        },
      }),
  };
  const chunks: Array<GramUIMessageChunk> = [];
  const [tool] = bindAppTools(
    [
      sendFileTool(
        {
          emitChunk: (_threadId, chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
              return "m-1" as never;
            }),
        },
        {
          getThread: () =>
            Effect.succeed({
              id: THREAD,
              checkout: { kind: "worktree", path: checkout, hostId: "box" },
            } as unknown as Thread),
        },
        machines,
      ),
    ],
    THREAD,
  );
  return { checkout, there, attachments, chunks, tool: tool! };
});

describe("send_file on a joined machine", () => {
  it.effect("shows a copy of the machine's file, never the file at that path here", () =>
    Effect.gen(function* () {
      const { there, attachments, chunks, tool } = yield* onMachine;
      const result = (yield* tool.run({ files: ["report.md"] })) as {
        sent: ReadonlyArray<{ path: string }>;
      };
      // The agent hears its own machine's path back.
      expect(result.sent).toEqual([
        { path: join(there, "report.md"), size: 26, mediaType: "text/markdown" },
      ]);
      expect(chunks).toHaveLength(1);
      const shown = fileURLToPath((chunks[0] as { url: string }).url);
      // Before this change the card named this machine's file at the thread's path.
      expect(shown.startsWith(join(attachments, THREAD))).toBe(true);
      expect(readFileSync(shown, "utf8")).toBe("# Synthetic remote report\n");
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.effect("shows nothing when the machine refuses any of the files", () =>
    Effect.gen(function* () {
      const { chunks, tool } = yield* onMachine;
      const error = yield* Effect.flip(tool.run({ files: ["report.md", "missing.md"] }));
      expect(error).toBeInstanceOf(AppToolError);
      expect(error.message).toContain("on box");
      expect(chunks).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.effect("refuses a joined machine's thread when nothing reaches machines", () =>
    Effect.gen(function* () {
      const chunks: Array<GramUIMessageChunk> = [];
      const [tool] = bindAppTools(
        [
          sendFileTool(
            { emitChunk: (_t, chunk) => Effect.sync(() => (chunks.push(chunk), "m" as never)) },
            {
              getThread: () =>
                Effect.succeed({
                  id: THREAD,
                  checkout: { kind: "worktree", path: tmpdir(), hostId: "box" },
                } as unknown as Thread),
            },
          ),
        ],
        THREAD,
      );
      const error = yield* Effect.flip(tool!.run({ files: ["anything"] }));
      expect(error.message).toContain("on another machine");
      expect(chunks).toEqual([]);
    }),
  );
});
