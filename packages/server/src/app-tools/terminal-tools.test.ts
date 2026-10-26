import { describe, expect, it } from "@effect/vitest";
import { AppToolError, type TerminalId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { TerminalSnapshot } from "../terminal/terminals.ts";
import { bindAppTools } from "./registry.ts";
import { OUTPUT_BUDGET, readTerminalTool } from "./terminal-tools.ts";

const THREAD = "t-1" as ThreadId;

const terminal = (id: string, scrollback: string, patch: Partial<TerminalSnapshot> = {}) =>
  ({
    terminalId: id as TerminalId,
    threadId: THREAD,
    cwd: "/repo",
    shell: "/bin/zsh",
    alive: true,
    scrollback,
    scrollbackCut: false,
    cols: 120,
    rows: 30,
    ...patch,
  }) satisfies TerminalSnapshot;

const toolFor = (byThread: Record<string, ReadonlyArray<TerminalSnapshot>>) => {
  const [tool] = bindAppTools(
    [readTerminalTool({ snapshot: (threadId) => Effect.succeed(byThread[threadId] ?? []) })],
    THREAD,
  );
  return tool!;
};

describe("read_terminal", () => {
  it.effect("returns every terminal of the calling thread as plain text, without a card", () =>
    Effect.gen(function* () {
      const tool = toolFor({
        [THREAD]: [
          terminal("a", "$ pnpm test\r\n\x1b[31mFAIL\x1b[0m src/x.test.ts\r\n$ "),
          terminal("b", "bye\r\n", { alive: false, exitCode: 1 }),
        ],
        other: [terminal("c", "secret")],
      });
      expect(tool.descriptor.class).toBe("read");
      expect(yield* tool.run({})).toEqual({
        terminals: [
          {
            terminalId: "a",
            cwd: "/repo",
            shell: "/bin/zsh",
            alive: true,
            output: "$ pnpm test\nFAIL src/x.test.ts\n$",
          },
          {
            terminalId: "b",
            cwd: "/repo",
            shell: "/bin/zsh",
            alive: false,
            exitCode: 1,
            output: "bye",
          },
        ],
      });
    }),
  );

  it.effect("scrubs credentials the shell printed or the user pasted", () =>
    Effect.gen(function* () {
      const token = `ghp_${"a1B2".repeat(9)}`;
      const tool = toolFor({
        [THREAD]: [
          terminal(
            "a",
            `$ export GH_TOKEN=${token}\r\n$ curl -H "Authorization: Bearer ${token}" x\r\n`,
          ),
        ],
      });
      const result = JSON.stringify(yield* tool.run({}));
      expect(result).not.toContain(token);
      expect(result).toContain("curl");
    }),
  );

  it.effect("splits one character budget between the terminals, keeping each one's end", () =>
    Effect.gen(function* () {
      const long = `${"x".repeat(OUTPUT_BUDGET)}\r\nlast line of a`;
      const tool = toolFor({
        [THREAD]: [terminal("a", long), terminal("b", "short"), terminal("c", `${long} and c`)],
      });
      const { terminals } = (yield* tool.run({})) as {
        terminals: ReadonlyArray<{ terminalId: string; output: string; truncated?: boolean }>;
      };
      expect(terminals.map((t) => t.terminalId)).toEqual(["a", "b", "c"]);
      expect(terminals[0]).toMatchObject({ output: "last line of a", truncated: true });
      expect(terminals[1]).toMatchObject({ output: "short" });
      expect(terminals[1]?.truncated).toBeUndefined();
      expect(terminals[2]?.output).toBe("last line of a and c");
      const total = terminals.reduce((sum, t) => sum + t.output.length, 0);
      expect(total).toBeLessThanOrEqual(OUTPUT_BUDGET);

      // One unbroken line has no line start to cut at: the end of it still fits the share.
      const one = toolFor({ [THREAD]: [terminal("a", "y".repeat(OUTPUT_BUDGET * 2))] });
      const [only] = ((yield* one.run({})) as { terminals: ReadonlyArray<{ output: string }> })
        .terminals;
      expect(only?.output.length).toBe(OUTPUT_BUDGET);
    }),
  );

  it.effect("narrows to one terminal and a line count, and refuses another thread's", () =>
    Effect.gen(function* () {
      const tool = toolFor({
        [THREAD]: [terminal("a", "1\r\n2\r\n3\r\n"), terminal("b", "x")],
        other: [terminal("c", "secret")],
      });
      expect(yield* tool.run({ terminalId: "a", lines: 2 })).toEqual({
        terminals: [
          {
            terminalId: "a",
            cwd: "/repo",
            shell: "/bin/zsh",
            alive: true,
            output: "2\n3",
            truncated: true,
          },
        ],
      });
      const refused = yield* Effect.flip(tool.run({ terminalId: "c" }));
      expect(refused).toBeInstanceOf(AppToolError);
      expect(yield* toolFor({}).run({})).toEqual({ terminals: [] });
    }),
  );
});
