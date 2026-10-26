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
import { bindAppTools } from "./registry.ts";
import { showMockTool } from "./show-mock.ts";

const THREAD = "t-mock" as ThreadId;

/** A worker's worktree holding a mock with two directions, and another mock outside it. */
const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-show-mock-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const worktree = join(dir, "repo", ".worktrees", "feat-needs-you-home");
  const mock = join(worktree, "docs", "design", "mocks", "needs-you-home");
  mkdirSync(join(mock, "shots"), { recursive: true });
  writeFileSync(
    join(mock, "mock.json"),
    JSON.stringify({
      title: "Needs you home",
      status: "in-review",
      current: 1,
      versions: [{ n: 1, file: "v1.html" }],
    }),
  );
  writeFileSync(join(mock, "v1.html"), "<!doctype html>");
  for (const shot of ["a-inbox-dark.png", "a-inbox-light.png", "c-popover-dark.png"]) {
    writeFileSync(join(mock, "shots", shot), "png");
  }
  const elsewhere = join(dir, "elsewhere", "mock.json");
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(elsewhere, JSON.stringify({ title: "Not yours", versions: [] }));

  const chunks: Array<GramUIMessageChunk> = [];
  const [tool] = bindAppTools(
    [
      showMockTool(
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
                  checkout: { kind: "worktree", path: worktree },
                } as unknown as Thread)
              : Effect.fail(new ThreadNotFound({ threadId })),
        },
      ),
    ],
    THREAD,
  );
  return { mock, elsewhere, chunks, tool: tool! };
});

describe("show_mock", () => {
  it.effect("puts the mock's card in the reply, from its folder in the worktree", () =>
    Effect.gen(function* () {
      const { mock, chunks, tool } = yield* setup;
      expect(tool.descriptor.class).toBe("self");
      expect(yield* tool.run({ path: "docs/design/mocks/needs-you-home" })).toEqual({
        shown: "Needs you home",
        version: 1,
        directions: [
          { name: "A inbox", themes: ["dark", "light"] },
          { name: "C popover", themes: ["dark"] },
        ],
      });
      expect(chunks).toEqual([
        {
          type: "data-mock",
          id: expect.any(String),
          data: {
            title: "Needs you home",
            status: "in-review",
            version: 1,
            page: join(mock, "v1.html"),
            record: join(mock, "mock.json"),
            directions: [
              {
                name: "A inbox",
                shots: {
                  dark: join(mock, "shots", "a-inbox-dark.png"),
                  light: join(mock, "shots", "a-inbox-light.png"),
                },
              },
              { name: "C popover", shots: { dark: join(mock, "shots", "c-popover-dark.png") } },
            ],
          },
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("shows nothing for a mock outside the thread's folders", () =>
    Effect.gen(function* () {
      const { elsewhere, chunks, tool } = yield* setup;
      const error = yield* Effect.flip(tool.run({ path: elsewhere }));
      expect(error).toBeInstanceOf(AppToolError);
      expect(error.message).toContain("mock.json is outside this thread's folders");
      expect(chunks).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
