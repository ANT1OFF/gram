import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  type GitState,
  type GramUIMessageChunk,
  type Thread,
  type ThreadId,
  type TurnId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { TurnRecord } from "../persistence/thread-store.ts";
import { bindAppTools } from "./registry.ts";
import { WRAP_UP_ASKED, WRAP_UP_CLOSE, WRAP_UP_DESCRIPTION, wrapUpTool } from "./wrap-up-tool.ts";

const THREAD = "t-wrap" as ThreadId;
const TURN = "turn-3" as TurnId;

/** On a branch that origin has as it is. */
const synced: GitState = {
  repo: true,
  branch: "feat/box",
  worktree: true,
  head: "abc",
  changesToken: "tok",
  changedFiles: 0,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 2,
  conflicts: false,
  upstream: "synced",
  origin: "someone/repo",
};

/** On a branch with commits origin hasn't got, and no PR yet. */
const unpushed: GitState = { ...synced, upstream: "ahead", aheadUpstream: 2 };

const setup = (
  options: { readonly turn?: TurnRecord | undefined; readonly git?: GitState } = {},
) => {
  const chunks: Array<GramUIMessageChunk> = [];
  const refreshes: Array<string> = [];
  const turn =
    "turn" in options
      ? options.turn
      : ({
          id: TURN,
          threadId: THREAD,
          startedAt: 0,
          endedAt: undefined,
          reason: undefined,
        } satisfies TurnRecord);
  const [tool] = bindAppTools(
    [
      wrapUpTool(
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
              checkout: { kind: "local", path: "/repo" },
            } as unknown as Thread),
          lastTurn: () => Effect.succeed(turn),
        },
        {
          stateForThread: () => Effect.succeed(options.git ?? unpushed),
          refresh: (path) => Effect.sync(() => void refreshes.push(path)),
        },
      ),
    ],
    THREAD,
  );
  return { chunks, refreshes, tool: tool! };
};

describe("wrap_up", () => {
  it("tells the agent when to call it, and when not", () => {
    // When: after the work is checked, last, and again if more work follows.
    expect(WRAP_UP_DESCRIPTION).toContain("as the last tool call of a turn that changed something");
    expect(WRAP_UP_DESCRIPTION).toContain("call it again: the newer box replaces the older");
    // A turn that stops blocked still gets a box; a question answered doesn't.
    expect(WRAP_UP_DESCRIPTION).toContain("stops early because you are blocked");
    expect(WRAP_UP_DESCRIPTION).toContain("even if you read files or ran commands to answer");
    expect(WRAP_UP_DESCRIPTION).toContain("a subagent never does");
    // A question needs its reasons said somewhere, and isn't asked twice.
    expect(WRAP_UP_DESCRIPTION).toContain("which go in your closing message");
    expect(WRAP_UP_DESCRIPTION).toContain("never for something another prompt already asks");
    expect(WRAP_UP_ASKED).toContain("without asking the question again");
    for (const next of [WRAP_UP_CLOSE, WRAP_UP_ASKED]) {
      expect(next).toContain("if you already wrote");
    }
  });

  it.effect("puts the recap on the turn's reply and says to write the closing message", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const { chunks, tool } = setup();
      const result = yield* tool.run({ recap: "  Added the box. The e2e spec has not run.  " });
      expect(result).toEqual({ shown: "recap", next: WRAP_UP_CLOSE });
      expect(chunks).toEqual([
        {
          type: "data-wrap-up",
          id: `wrap-up:${TURN}`,
          data: {
            id: `wrap-up:${TURN}`,
            turnId: TURN,
            recap: "Added the box. The e2e spec has not run.",
            actions: [],
            at: 1_000,
          },
        },
      ]);
    }),
  );

  it.effect("with a question, shows its buttons and says to explain it without asking again", () =>
    Effect.gen(function* () {
      const { chunks, refreshes, tool } = setup();
      const result = yield* tool.run({
        recap: "The box renders. Nothing is pushed.",
        ask: "Push the branch?",
        actions: [{ action: "push" }, { label: "Not yet", message: "Leave it unpushed for now" }],
      });
      expect(result).toEqual({
        shown: "recap and question",
        buttons: ["push", "Not yet"],
        next: WRAP_UP_ASKED,
      });
      // Read again first: the agent has often only just committed.
      expect(refreshes).toEqual(["/repo"]);
      const chunk = chunks[0];
      expect(chunk?.type === "data-wrap-up" ? chunk.data : undefined).toMatchObject({
        ask: "Push the branch?",
        actions: [
          { kind: "app", action: "push" },
          { kind: "reply", label: "Not yet", message: "Leave it unpushed for now" },
        ],
      });
    }),
  );

  it.effect("a reply without a message sends its label", () =>
    Effect.gen(function* () {
      const { chunks, tool } = setup();
      yield* tool.run({ recap: "Done.", ask: "Ship it?", actions: [{ label: "Ship it" }] });
      const chunk = chunks[0];
      expect(chunk?.type === "data-wrap-up" ? chunk.data.actions : undefined).toEqual([
        { kind: "reply", label: "Ship it", message: "Ship it" },
      ]);
    }),
  );

  it.effect("refuses what breaks the box's rules, and shows nothing", () =>
    Effect.gen(function* () {
      const { chunks, tool } = setup();
      const refusals: Array<[unknown, string]> = [
        [{ recap: "  " }, "recap is empty"],
        [{ recap: "x".repeat(301) }, "recap: limit 300 characters; actual length 301"],
        [{ recap: "One.\nTwo." }, "one line"],
        [
          { recap: "Done.", ask: `${"x".repeat(100)}?` },
          "ask: limit 100 characters; actual length 101",
        ],
        [{ recap: "Done.", ask: "Push? Or merge?" }, "one question"],
        [{ recap: "Done.", actions: [{ label: "Go" }] }, "pass ask too"],
        [
          { recap: "Done.", ask: "Go?", actions: [{ label: "A" }, { label: "B" }, { label: "C" }] },
          "actions: limit 2 items; actual length 3",
        ],
        [{ recap: "Done.", ask: "Go?", actions: [{ label: "A" }, { label: "A" }] }, "must differ"],
        [
          { recap: "Done.", ask: "Go?", actions: [{ label: "x".repeat(25) }] },
          "actions[0].label: limit 24 characters; actual length 25",
        ],
        [{ recap: "Done.", ask: "Go?", actions: [{}] }, "label is empty"],
        [{ recap: "Done.", ask: "Go?", actions: [{ action: "push", label: "Push" }] }, "not both"],
        [{ recap: "Done.", unknown: true }, "unknown"],
      ];
      for (const [input, message] of refusals) {
        const refused = yield* Effect.flip(tool.run(input));
        expect(refused, JSON.stringify(input)).toBeInstanceOf(AppToolError);
        expect(refused.message.toLowerCase(), JSON.stringify(input)).toContain(message);
      }
      expect(chunks).toEqual([]);
    }),
  );

  it.effect("offers an app action only while the thread's header would", () =>
    Effect.gen(function* () {
      const { tool } = setup();
      // Unpushed, with no PR: Push and Create PR, but nothing to merge.
      const merge = yield* Effect.flip(
        tool.run({ recap: "Done.", ask: "Merge?", actions: [{ action: "merge" }] }),
      );
      expect(merge.message).toBe(
        "merge isn't available for this thread now; available: push, create_pr.",
      );
      const pushed = setup({ git: synced });
      yield* pushed.tool.run({
        recap: "Done.",
        ask: "Open a PR?",
        actions: [{ action: "create_pr" }],
      });
      const open = setup({
        git: {
          ...synced,
          pr: { number: 7, state: "OPEN", isDraft: false } as NonNullable<GitState["pr"]>,
        },
      });
      yield* open.tool.run({ recap: "Done.", ask: "Merge #7?", actions: [{ action: "merge" }] });
      const none = setup({ git: { ...unpushed, repo: false } });
      const refused = yield* Effect.flip(
        none.tool.run({ recap: "Done.", ask: "Push?", actions: [{ action: "push" }] }),
      );
      expect(refused.message).toContain("nor is any app action");
    }),
  );

  it.effect("refuses outside a running turn", () =>
    Effect.gen(function* () {
      for (const turn of [
        undefined,
        {
          id: TURN,
          threadId: THREAD,
          startedAt: 0,
          endedAt: 5,
          reason: "completed",
        } satisfies TurnRecord,
      ]) {
        const { chunks, tool } = setup({ turn });
        const refused = yield* Effect.flip(tool.run({ recap: "Done." }));
        expect(refused.message).toContain("before the turn ends");
        expect(chunks).toEqual([]);
      }
    }),
  );
});
