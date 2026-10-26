import { describe, expect, it } from "vitest";

import { checkShell, ptyInvocation } from "./shell-check.ts";

const installed = new Set([
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "D:\\tools\\nu shell\\nu.cmd",
  "C:\\Windows\\System32\\cmd.exe",
]);
const exists = (path: string) => installed.has(path);
const PATH = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7\\";

describe("checkShell", () => {
  it("resolves profiles, names on PATH and full paths on Windows", () => {
    expect(checkShell("pwsh", "win32", PATH, exists)).toEqual({
      found: true,
      file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });
    expect(checkShell(" D:\\tools\\nu shell\\nu.cmd ", "win32", PATH, exists)).toEqual({
      found: true,
      file: "D:\\tools\\nu shell\\nu.cmd",
    });
  });

  it("gives resolveShell's message for a missing shell", () => {
    expect(checkShell("git-bash", "win32", PATH, exists)).toMatchObject({
      found: false,
      message: expect.stringContaining("Install Git for Windows"),
    });
    expect(checkShell("D:\\missing\\fish.exe", "win32", PATH, exists)).toEqual({
      found: false,
      message:
        "D:\\missing\\fish.exe doesn't exist. Choose an installed terminal shell in Settings.",
    });
    expect(checkShell("   ", "win32", PATH, exists)).toMatchObject({ found: false });
  });

  it("accepts any value elsewhere, where the login shell runs instead", () => {
    expect(checkShell("/opt/homebrew/bin/fish", "darwin", "", exists)).toEqual({
      found: true,
      file: "/opt/homebrew/bin/fish",
    });
  });
});

describe("ptyInvocation", () => {
  it("runs a Windows batch file through cmd.exe with escaped arguments", () => {
    expect(
      ptyInvocation("D:\\tools\\nu shell\\nu.cmd", ["--login"], "win32", {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", 'D:\\tools\\nu^ shell\\nu.cmd ^"--login^"'],
    });
  });

  it("spawns executables directly", () => {
    expect(ptyInvocation("C:\\Windows\\System32\\cmd.exe", [], "win32", {})).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    });
    expect(ptyInvocation("/bin/zsh", ["-l"], "darwin", {})).toEqual({
      file: "/bin/zsh",
      args: ["-l"],
    });
  });
});
