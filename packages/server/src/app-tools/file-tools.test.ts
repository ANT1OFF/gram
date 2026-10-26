import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  ThreadNotFound,
  type GramUIMessageChunk,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bindAppTools } from "./registry.ts";
import { sendFileTool, sentMediaType } from "./file-tools.ts";

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
