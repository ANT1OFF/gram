import { describe, expect, it } from "vitest";

import { formatDroppedPaths, quoteShellPath, shellKind } from "./shell-quote";

describe("shellKind", () => {
  it("tells the running shell's quoting rules from its executable", () => {
    expect(shellKind("/bin/zsh")).toBe("posix");
    expect(shellKind("/opt/homebrew/bin/fish")).toBe("posix");
    expect(shellKind("/bin/bash")).toBe("posix");
    expect(shellKind("powershell.exe")).toBe("powershell");
    expect(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
    expect(shellKind("cmd.exe")).toBe("cmd");
    expect(shellKind("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("git-bash");
  });
});

describe("quoteShellPath", () => {
  const nasty = "/Users/me/my repo/it's & $HOME %PATH%.txt";

  it("leaves simple paths bare everywhere", () => {
    expect(quoteShellPath("/Users/me/src/a.ts", "posix")).toBe("/Users/me/src/a.ts");
    expect(quoteShellPath("C:\\code\\a.ts", "powershell")).toBe("C:\\code\\a.ts");
    expect(quoteShellPath("C:\\code\\a.ts", "cmd")).toBe("C:\\code\\a.ts");
  });

  it("single-quotes for POSIX shells, escaping quotes and keeping $ and & literal", () => {
    expect(quoteShellPath(nasty, "posix")).toBe(`'/Users/me/my repo/it'\\''s & $HOME %PATH%.txt'`);
  });

  it("converts to an MSYS path for Git Bash, then single-quotes", () => {
    expect(quoteShellPath("C:\\Users\\me\\my repo\\it's $x.txt", "git-bash")).toBe(
      `'/c/Users/me/my repo/it'\\''s $x.txt'`,
    );
  });

  it("single-quotes for PowerShell with doubled quotes, so $ and & stay literal", () => {
    expect(quoteShellPath("C:\\Users\\me\\my repo\\it's & $HOME.txt", "powershell")).toBe(
      "'C:\\Users\\me\\my repo\\it''s & $HOME.txt'",
    );
  });

  it("double-quotes for cmd with every % escaped outside the quotes", () => {
    expect(quoteShellPath("C:\\Users\\me\\a b & %USERPROFILE%.txt", "cmd")).toBe(
      '"C:\\Users\\me\\a b & "^%"USERPROFILE"^%".txt"',
    );
  });
});

describe("formatDroppedPaths", () => {
  it("joins quoted paths with a trailing space, and types nothing for no paths", () => {
    expect(formatDroppedPaths(["/a b", "/c"], "posix")).toBe("'/a b' /c ");
    expect(formatDroppedPaths([], "posix")).toBe("");
  });
});
