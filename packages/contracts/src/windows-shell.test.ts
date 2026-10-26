import { describe, expect, it } from "vitest";
import {
  batchFileInvocation,
  escapeCmdArgument,
  escapeCmdCommand,
  isWindowsBatchFile,
} from "./windows-shell.ts";

describe("windows batch files", () => {
  it("recognises .cmd and .bat in any case, and nothing else", () => {
    expect(isWindowsBatchFile("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd")).toBe(true);
    expect(isWindowsBatchFile("C:\\tools\\run.BAT")).toBe(true);
    expect(isWindowsBatchFile("C:\\Users\\me\\.local\\bin\\claude.exe")).toBe(false);
    expect(isWindowsBatchFile("claude")).toBe(false);
  });

  it("caret-escapes the command path, spaces included", () => {
    expect(escapeCmdCommand("C:\\Program Files\\Claude (beta)\\claude.cmd")).toBe(
      "C:\\Program^ Files\\Claude^ ^(beta^)\\claude.cmd",
    );
  });

  it("quotes and escapes arguments like cross-spawn", () => {
    expect(escapeCmdArgument("a b & c", false)).toBe('^"a^ b^ ^&^ c^"');
    expect(escapeCmdArgument("%PATH%!", false)).toBe('^"^%PATH^%^!^"');
    expect(escapeCmdArgument('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeCmdArgument("C:\\dir\\", false)).toBe('^"C:\\dir\\\\^"');
    expect(escapeCmdArgument("a&b", true)).toBe('^^^"a^^^&b^^^"');
  });

  it("preserves backslash runs before text, quotes and the end", () => {
    for (const count of [0, 1, 2, 7, 100_000]) {
      const run = "\\".repeat(count);
      expect(escapeCmdArgument(`${run}tail`, false)).toBe(`^"${run}tail^"`);
      expect(escapeCmdArgument(`${run}"tail`, false)).toBe(
        `^"${"\\".repeat(count * 2 + 1)}^"tail^"`,
      );
      expect(escapeCmdArgument(run, false)).toBe(`^"${"\\".repeat(count * 2)}^"`);
    }
    expect(escapeCmdArgument("🦉\\", false)).toBe('^"🦉\\\\^"');
  });

  it("escapes twice only for npm's node_modules\\.bin shims", () => {
    expect(batchFileInvocation("C:\\npm\\claude.cmd", ["mcp", "a b"])).toEqual({
      file: "C:\\npm\\claude.cmd",
      args: ['^"mcp^"', '^"a^ b^"'],
    });
    expect(batchFileInvocation("C:\\repo\\node_modules\\.bin\\tool.cmd", ["x&y"]).args).toEqual([
      '^^^"x^^^&y^^^"',
    ]);
  });
});
