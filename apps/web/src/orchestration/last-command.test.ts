import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { lastCommandOf, terminalText } from "./last-command";

let ids = 0;
const message = (...parts: unknown[]): GramUIMessage =>
  ({ id: `m${++ids}`, role: "assistant", parts }) as unknown as GramUIMessage;

/** A Bash call as Claude's adapter stores it: a typed tool part. */
const bash = (toolCallId: string, command: string, more: Record<string, unknown>) => ({
  type: "tool-Bash",
  toolCallId,
  input: { command },
  ...more,
});

/** A command as Codex's adapter streams it: a dynamic tool part under Claude's name. */
const codex = (toolCallId: string, command: string, more: Record<string, unknown>) => ({
  type: "dynamic-tool",
  toolName: "Bash",
  toolCallId,
  input: { command },
  ...more,
});

describe("a worker's terminal", () => {
  it("is nothing before the worker runs a command", () => {
    expect(lastCommandOf([])).toBeUndefined();
    expect(lastCommandOf([message({ type: "text", text: "Reading." })])).toBeUndefined();
  });

  it("shows a running command's output as it streams in, then its exit", () => {
    const running = codex("c1", "uv run pytest tests/queue", {
      state: "output-available",
      preliminary: true,
      output: { stdout: "collected 52 items\n....", stderr: "", interrupted: false },
    });
    expect(lastCommandOf([message(running)])).toEqual({
      toolCallId: "c1",
      command: "uv run pytest tests/queue",
      output: "collected 52 items\n....",
      running: true,
      failed: false,
    });
    const exited = codex("c1", "uv run pytest tests/queue", {
      state: "output-available",
      output: { stdout: "52 passed in 41.2s", stderr: "", interrupted: false, exitCode: 0 },
    });
    expect(lastCommandOf([message(exited)])).toMatchObject({
      output: "52 passed in 41.2s",
      running: false,
      exitCode: 0,
    });
  });

  it("counts a command as running from its call to its last output", () => {
    for (const state of ["input-streaming", "input-available", "approval-responded"]) {
      expect(lastCommandOf([message(bash("b1", "ls", { state }))])).toMatchObject({
        running: true,
        output: "",
      });
    }
    expect(
      lastCommandOf([message(bash("b1", "rm -rf build", { state: "approval-requested" }))]),
    ).toMatchObject({ running: false, failed: false });
  });

  it("shows the newest command, as a terminal shows the last one typed", () => {
    const messages = [
      message(
        codex("dev", "bun run dev", {
          state: "output-available",
          preliminary: true,
          output: { stdout: "ready" },
        }),
      ),
      message(
        { type: "text", text: "Listing." },
        bash("ls", "ls", { state: "output-available", output: "a\nb" }),
        bash("read", "", { state: "output-available", output: "" }),
        {
          type: "tool-Read",
          toolCallId: "r",
          state: "output-available",
          input: { file_path: "a" },
        },
      ),
    ];
    expect(lastCommandOf(messages)).toMatchObject({ toolCallId: "ls", output: "a\nb" });
    expect(lastCommandOf(messages.slice(0, 1))).toMatchObject({ toolCallId: "dev", running: true });
  });

  it("keeps a command the agent backgrounded running until its task ends", () => {
    const messages = [
      message(
        bash("bg", "npm run watch", {
          state: "output-available",
          output: "Command running in background with ID: bash_1",
        }),
      ),
    ];
    expect(lastCommandOf(messages)).toMatchObject({ running: false });
    expect(lastCommandOf(messages, new Set(["bg"]))).toMatchObject({ running: true });
  });

  it("shows a background shell's output from beside the transcript, in place of its result", () => {
    const messages = [
      message(
        bash("bg", "pnpm dev", {
          state: "output-available",
          output: { stdout: "", stderr: "", backgroundTaskId: "b1" },
        }),
      ),
    ];
    const output = new Map([
      ["bg", "\u001b[32mVITE ready\u001b[0m\nlocal: http://localhost:5173/\n"],
    ]);
    expect(lastCommandOf(messages, new Set(["bg"]), output)).toMatchObject({
      toolCallId: "bg",
      running: true,
      output: "VITE ready\nlocal: http://localhost:5173/\n",
    });
    // Ended, it keeps showing what it last wrote.
    expect(lastCommandOf(messages, new Set(), output)).toMatchObject({
      running: false,
      output: "VITE ready\nlocal: http://localhost:5173/\n",
    });
    // Another call's output isn't this one's.
    expect(lastCommandOf(messages, new Set(["bg"]), new Map([["other", "x"]]))).toMatchObject({
      output: "",
    });
    const long = new Map([["bg", "y".repeat(20_000)]]);
    expect(lastCommandOf(messages, new Set(["bg"]), long)?.output).toHaveLength(8_000);
  });

  it("says when a command failed, and with what", () => {
    const failed = bash("f", "false", { state: "output-error", errorText: "Exit code 1" });
    expect(lastCommandOf([message(failed)])).toMatchObject({
      failed: true,
      output: "Exit code 1",
    });
    const nonzero = codex("n", "pytest", {
      state: "output-available",
      output: { stdout: "1 failed", exitCode: 1 },
    });
    expect(lastCommandOf([message(nonzero)])).toMatchObject({ failed: false, exitCode: 1 });
  });

  it("keeps only the tail of a long output", () => {
    const long = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n");
    const last = lastCommandOf([
      message(
        codex("l", "yes", {
          state: "output-available",
          preliminary: true,
          output: { stdout: long },
        }),
      ),
    ]);
    expect(last!.output.length).toBe(8_000);
    expect(last!.output.endsWith("line 1999")).toBe(true);
  });
});

describe("terminal text", () => {
  it("leaves plain output alone", () => {
    expect(terminalText("a\n  b\tc")).toBe("a\n  b\tc");
  });

  it("drops colours, cursor moves, titles and links", () => {
    expect(terminalText("\u001b[32m52 passed\u001b[0m in \u001b[1m41.2s\u001b[22m")).toBe(
      "52 passed in 41.2s",
    );
    expect(terminalText("\u001b[2K\u001b[1Gdone")).toBe("done");
    expect(terminalText("\u001b]0;pytest\u0007ok")).toBe("ok");
    expect(terminalText("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\")).toBe(
      "link",
    );
    expect(terminalText("\u001b(Bplain\u001b=")).toBe("plain");
  });

  it("shows only a progress line's last rewrite", () => {
    expect(terminalText("[1/3]\r[2/3]\r[3/3]\ndone\r\n")).toBe("[3/3]\ndone\n");
    expect(terminalText("windows\r\nline\r\n")).toBe("windows\nline\n");
  });

  it("drops other control characters", () => {
    expect(terminalText("bell\u0007 nul\u0000 ok")).toBe("bell nul ok");
  });
});
