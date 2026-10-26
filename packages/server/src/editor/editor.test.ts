import { describe, expect, it } from "vitest";

import { editorCommand, resolveEditorBin, revealCommand, splitCommand } from "./editor.ts";

const file = { path: "/repo/src/a.ts", line: 12, folder: false };
const folder = { path: "/repo", folder: true };

const windowsBinExists = (candidate: string) =>
  candidate === "C:\\bin\\code.cmd" || candidate === "C:\\tools\\zed.exe";

describe("revealCommand", () => {
  it("selects the path in Finder or Explorer, else opens its folder", () => {
    expect(revealCommand("/repo/src/a.ts", false, "darwin")).toEqual({
      name: "Finder",
      bin: "open",
      args: ["-R", "/repo/src/a.ts"],
      verbatim: false,
    });
    expect(revealCommand("C:\\repo\\a b.ts", false, "win32")).toEqual({
      name: "Explorer",
      bin: "explorer.exe",
      args: ['/select,"C:\\repo\\a b.ts"'],
      verbatim: true,
    });
    expect(revealCommand("/repo/src/a.ts", false, "linux").args).toEqual(["/repo/src"]);
    expect(revealCommand("/repo", true, "linux").args).toEqual(["/repo"]);
  });
});

describe("editorCommand", () => {
  it("defaults to VS Code and jumps to the line", () => {
    expect(editorCommand(undefined, file)).toEqual({
      name: "VS Code",
      bin: "code",
      args: ["-g", "/repo/src/a.ts:12"],
    });
    expect(editorCommand("", folder).args).toEqual(["/repo"]);
  });

  it("addresses a line per preset, ignoring extra flags", () => {
    expect(editorCommand("code -g", file).args).toEqual(["-g", "/repo/src/a.ts:12"]);
    expect(editorCommand("cursor", file)).toMatchObject({ name: "Cursor" });
    expect(editorCommand("zed", file).args).toEqual(["/repo/src/a.ts:12"]);
    expect(editorCommand("idea", file).args).toEqual(["--line", "12", "/repo/src/a.ts"]);
    expect(editorCommand("idea", folder).args).toEqual(["/repo"]);
    expect(
      editorCommand("/usr/local/bin/code", { path: "/repo/b.ts", folder: false }),
    ).toMatchObject({ name: "VS Code", args: ["/repo/b.ts"] });
  });

  it("substitutes a custom template, appending the path when it has no {path}", () => {
    expect(editorCommand('subl "{path}:{line}"', file)).toEqual({
      name: "subl",
      bin: "subl",
      args: ["/repo/src/a.ts:12"],
    });
    expect(editorCommand("nvim-qt --remote", folder).args).toEqual(["--remote", "/repo"]);
    expect(
      editorCommand("code --goto {path}:{line}", { path: "/r/x", folder: false }).args,
    ).toEqual(["--goto", "/r/x:1"]);
  });

  it("splits quoted parts", () => {
    expect(splitCommand('"C:\\Program Files\\ed.exe" --wait')).toEqual([
      "C:\\Program Files\\ed.exe",
      "--wait",
    ]);
  });
});

describe("resolveEditorBin", () => {
  it("passes names through outside Windows", () => {
    expect(resolveEditorBin("code", "darwin", "/usr/bin")).toEqual({ file: "code", shell: false });
  });

  it("finds the .cmd shim on Windows, then an .exe", () => {
    const path = "C:\\bin;C:\\tools\\";
    expect(resolveEditorBin("code", "win32", path, windowsBinExists)).toEqual({
      file: "C:\\bin\\code.cmd",
      shell: true,
    });
    expect(resolveEditorBin("zed", "win32", path, windowsBinExists)).toEqual({
      file: "C:\\tools\\zed.exe",
      shell: false,
    });
    expect(resolveEditorBin("cursor", "win32", path, () => false)).toEqual({
      file: "cursor.cmd",
      shell: true,
    });
    expect(resolveEditorBin("C:\\x\\idea.bat", "win32", path, windowsBinExists)).toEqual({
      file: "C:\\x\\idea.bat",
      shell: true,
    });
  });
});
