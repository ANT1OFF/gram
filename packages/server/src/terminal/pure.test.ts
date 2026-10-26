import { describe, expect, it } from "vitest";

import { coalesce } from "./batch.ts";
import { Scrollback } from "./scrollback.ts";
import { resolveShell, shellCommand, signalName, terminalEnv, WINDOWS_SHELLS } from "./shell.ts";

const existing =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe("Scrollback", () => {
  it("keeps everything below the cap", () => {
    const buffer = new Scrollback(10);
    buffer.append("abc");
    buffer.append("def");
    expect(buffer.toString()).toBe("abcdef");
    expect(buffer.size).toBe(6);
  });

  it("drops the oldest output past the cap, splitting a chunk if needed", () => {
    const buffer = new Scrollback(10);
    for (const chunk of ["0123", "4567", "89ab", "cdef"]) buffer.append(chunk);
    expect(buffer.toString()).toBe("6789abcdef");
    expect(buffer.size).toBe(10);
  });

  it("keeps only the tail of a chunk larger than the cap", () => {
    const buffer = new Scrollback(4);
    buffer.append("xy");
    buffer.append("0123456789");
    expect(buffer.toString()).toBe("6789");
    buffer.append("!");
    expect(buffer.toString()).toBe("789!");
  });
});

describe("coalesce", () => {
  it("joins adjacent data and keeps replay and exit in order", () => {
    expect(
      coalesce([
        { type: "replay", data: "old" },
        { type: "data", data: "a" },
        { type: "data", data: "b" },
        { type: "exit", code: 0 },
      ]),
    ).toEqual([
      { type: "replay", data: "old" },
      { type: "data", data: "ab" },
      { type: "exit", code: 0 },
    ]);
  });
});

describe("shellCommand", () => {
  it("runs the login shell on Unix", () => {
    expect(
      shellCommand(undefined, undefined, { SHELL: "/opt/homebrew/bin/fish" }, "darwin"),
    ).toEqual({
      file: "/opt/homebrew/bin/fish",
      args: ["-l"],
    });
    expect(shellCommand(undefined, undefined, {}, "linux").file).toBe("/bin/bash");
    expect(shellCommand("/bin/sh", undefined, { SHELL: "/bin/zsh" }, "darwin").file).toBe(
      "/bin/sh",
    );
  });

  it("uses the setting or PowerShell on Windows, without login args", () => {
    expect(shellCommand(undefined, undefined, {}, "win32")).toEqual({
      file: "powershell.exe",
      args: [],
    });
    expect(shellCommand(undefined, "pwsh.exe", {}, "win32").file).toBe("pwsh.exe");
  });

  it("maps the Windows shell profiles the settings and migration write", () => {
    expect(shellCommand(undefined, "cmd", {}, "win32")).toEqual({ file: "cmd.exe", args: [] });
    expect(shellCommand(undefined, "git-bash", {}, "win32")).toEqual({
      file: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
    });
    expect(shellCommand(undefined, "toString", {}, "win32").file).toBe("toString");
    expect(shellCommand("cmd.exe", "git-bash", {}, "win32").file).toBe("cmd.exe");
  });
});

describe("resolveShell", () => {
  const PATH = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7\\";
  const missingShellMessage = (file: string) => {
    const result = resolveShell(file, "win32", PATH, existing());
    return result.found ? "" : result.message;
  };

  it("looks a bare name up on PATH on Windows, adding .exe when it has no extension", () => {
    expect(
      resolveShell(
        "powershell.exe",
        "win32",
        PATH,
        existing("C:\\Windows\\System32\\powershell.exe"),
      ),
    ).toEqual({ found: true, file: "C:\\Windows\\System32\\powershell.exe" });
    expect(
      resolveShell("pwsh", "win32", PATH, existing("C:\\Program Files\\PowerShell\\7\\pwsh.exe")),
    ).toEqual({ found: true, file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" });
    expect(resolveShell("C:\\tools\\nu.exe", "win32", PATH, existing("C:\\tools\\nu.exe"))).toEqual(
      { found: true, file: "C:\\tools\\nu.exe" },
    );
  });

  it("explains a missing profile shell, path or name instead of spawning it", () => {
    expect(missingShellMessage("pwsh.exe")).toContain("Install PowerShell 7");
    expect(missingShellMessage(WINDOWS_SHELLS["git-bash"]!.file)).toContain(
      "Install Git for Windows",
    );
    expect(missingShellMessage("C:\\tools\\nu.exe")).toBe(
      "C:\\tools\\nu.exe doesn't exist. Choose an installed terminal shell in Settings.",
    );
    expect(missingShellMessage("nu")).toContain("nu isn't on PATH");
  });

  it("leaves Unix shells to the spawn", () => {
    expect(resolveShell("/bin/zsh", "darwin", "", existing())).toEqual({
      found: true,
      file: "/bin/zsh",
    });
  });
});

describe("terminalEnv", () => {
  it("sets the probed PATH and colour support", () => {
    const env = terminalEnv(
      { PATH: "/usr/bin", HOME: "/Users/x", UNSET: undefined },
      "/opt/homebrew/bin:/usr/bin",
      "darwin",
    );
    expect(env).toMatchObject({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/x",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    expect("UNSET" in env).toBe(false);
    expect(terminalEnv({ Path: "C:\\bin" }, "/ignored", "win32")["PATH"]).toBeUndefined();
  });
});

describe("signalName", () => {
  it("names a signal number and ignores none", () => {
    expect(signalName(9)).toBe("SIGKILL");
    expect(signalName(0)).toBeUndefined();
    expect(signalName(undefined)).toBeUndefined();
  });
});
