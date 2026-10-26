import { AgentUnavailable } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  supportsFastControl,
  checkAuthStatus,
  classifyExecutable,
  expectedCliVersion,
  npmShimTarget,
  parseCliVersion,
  parseProbeOutput,
  pathCandidates,
  requireSdkExecutable,
  resolveBinary,
  resolveSdkExecutable,
  restoresSessionCost,
  sdkExecutablePath,
  versionWarning,
  type BinaryFs,
} from "./binary.ts";

const bytes = (...values: Array<number>) => new Uint8Array(values);
const text = (s: string) => new TextEncoder().encode(s);

const CMUX_WRAPPER = text(
  "#!/usr/bin/env bash\n# cmux claude wrapper - injects hooks and session tracking\n",
);

describe("parseProbeOutput", () => {
  it("reads the path and env after any shell banner", () => {
    const stdout =
      "Welcome to zsh!\n\0__SB_PROBE__\0/Users/me/.local/bin/claude\n\0__SB_ENV__\0PATH=/a:/b\0HOME=/Users/me\0MULTI=line1\nline2\0";
    expect(parseProbeOutput(stdout)).toEqual({
      commandPath: "/Users/me/.local/bin/claude",
      env: { PATH: "/a:/b", HOME: "/Users/me", MULTI: "line1\nline2" },
    });
  });

  it("ignores aliases and missing results", () => {
    expect(parseProbeOutput("\0__SB_PROBE__\0alias claude='x'\n\0__SB_ENV__\0A=1\0")).toEqual({
      env: { A: "1" },
    });
    expect(parseProbeOutput("\0__SB_PROBE__\0\0__SB_ENV__\0A=1\0")).toEqual({ env: { A: "1" } });
  });
});

describe("classifyExecutable", () => {
  it("recognises native binaries", () => {
    expect(classifyExecutable(bytes(0xcf, 0xfa, 0xed, 0xfe))).toBe("native");
    expect(classifyExecutable(bytes(0xca, 0xfe, 0xba, 0xbe))).toBe("native");
    expect(classifyExecutable(bytes(0x7f, 0x45, 0x4c, 0x46))).toBe("native");
    expect(classifyExecutable(text("MZ\x90\x00"))).toBe("native");
  });

  it("flags shell-script wrappers but accepts interpreter scripts", () => {
    expect(classifyExecutable(CMUX_WRAPPER)).toBe("shellWrapper");
    expect(classifyExecutable(text("#!/bin/sh\nexec claude"))).toBe("shellWrapper");
    expect(classifyExecutable(text("#!/usr/bin/env node\n"))).toBe("script");
    expect(classifyExecutable(text("#!/usr/bin/env -S node --no-warnings\n"))).toBe("script");
    expect(classifyExecutable(text("hello"))).toBe("unknown");
  });
});

describe("pathCandidates", () => {
  it("joins every PATH entry with the platform's binary name", () => {
    expect(pathCandidates({ PATH: "/a:/b/:" }, "darwin")).toEqual(["/a/claude", "/b/claude"]);
    expect(pathCandidates({ Path: "C:\\bin;D:\\tools\\" }, "win32")).toEqual([
      "C:\\bin\\claude.exe",
      "C:\\bin\\claude.cmd",
      "D:\\tools\\claude.exe",
      "D:\\tools\\claude.cmd",
    ]);
  });
});

/** What `npm i -g @anthropic-ai/claude-code` writes as `claude.cmd`: a shim for a native exe. */
const NATIVE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  "",
].join("\r\n");

/** A shim for a script run through `node`, which mentions `node.exe` but doesn't run it directly. */
const SCRIPT_SHIM = [
  "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ")",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*',
].join("\r\n");

const NPM_SHIM = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
const SHIMMED_EXE =
  "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

describe("npmShimTarget", () => {
  it("reads the native exe a shim runs, relative to the shim's folder", () => {
    expect(npmShimTarget(NPM_SHIM, NATIVE_SHIM)).toBe(SHIMMED_EXE);
  });

  it("reads pnpm's and yarn's `%~dp0` form too", () => {
    const pnpmShim = '@SETLOCAL\r\n@"%~dp0\\..\\claude-code\\bin\\claude.exe"   %*\r\n';
    expect(npmShimTarget("C:\\Users\\me\\pnpm\\bin\\claude.cmd", pnpmShim)).toBe(
      "C:\\Users\\me\\pnpm\\claude-code\\bin\\claude.exe",
    );
  });

  it("gives nothing for a shim that runs a script through node", () => {
    expect(npmShimTarget(NPM_SHIM, SCRIPT_SHIM)).toBe(undefined);
  });
});

const sdkExecutableOf = (path: string, platform: NodeJS.Platform, fs: BinaryFs) =>
  Effect.runPromise(resolveSdkExecutable(path, platform, fs));

describe("resolveSdkExecutable", () => {
  it("reads a Windows shim for the exe it runs, once that exe exists", async () => {
    const fs = fakeFs({ [NPM_SHIM]: { head: text(NATIVE_SHIM) }, [SHIMMED_EXE]: { head: native } });
    expect(await sdkExecutableOf(NPM_SHIM, "win32", fs)).toBe(SHIMMED_EXE);
  });

  it("leaves the SDK its bundled CLI for a missing exe, a script shim or an unreadable shim", async () => {
    expect(
      await sdkExecutableOf(NPM_SHIM, "win32", fakeFs({ [NPM_SHIM]: { head: text(NATIVE_SHIM) } })),
    ).toBe(undefined);
    expect(
      await sdkExecutableOf(NPM_SHIM, "win32", fakeFs({ [NPM_SHIM]: { head: text(SCRIPT_SHIM) } })),
    ).toBe(undefined);
    expect(await sdkExecutableOf(NPM_SHIM, "win32", fakeFs({}))).toBe(undefined);
  });

  it("passes a native binary through without reading it", async () => {
    expect(await sdkExecutableOf("/Users/me/.local/bin/claude", "darwin", fakeFs({}))).toBe(
      "/Users/me/.local/bin/claude",
    );
  });
});

describe("requireSdkExecutable", () => {
  const scriptShim = fakeFs({ [NPM_SHIM]: { head: text(SCRIPT_SHIM) } });

  it("fails a script shim as not found once the SDK has no CLI of its own to fall back to", async () => {
    const error = await Effect.runPromise(
      Effect.flip(requireSdkExecutable(NPM_SHIM, "win32", scriptShim, () => false)),
    );
    expect(error).toBeInstanceOf(AgentUnavailable);
    expect(error.reason).toBe("claude-not-found");
    expect(error.message).toContain(NPM_SHIM);
  });

  it("leaves the SDK its bundled CLI when there is one, and passes a shim's exe through", async () => {
    expect(
      await Effect.runPromise(requireSdkExecutable(NPM_SHIM, "win32", scriptShim, () => true)),
    ).toBe(undefined);
    const fs = fakeFs({ [NPM_SHIM]: { head: text(NATIVE_SHIM) }, [SHIMMED_EXE]: { head: native } });
    expect(await Effect.runPromise(requireSdkExecutable(NPM_SHIM, "win32", fs, () => false))).toBe(
      SHIMMED_EXE,
    );
  });
});

describe("sdkExecutablePath", () => {
  it("hands the SDK a native CLI, or the one a Windows shim runs", () => {
    expect(sdkExecutablePath("C:\\Users\\me\\.local\\bin\\claude.exe", "win32")).toBe(
      "C:\\Users\\me\\.local\\bin\\claude.exe",
    );
    expect(sdkExecutablePath(NPM_SHIM, "win32", NATIVE_SHIM)).toBe(SHIMMED_EXE);
    // Unread, or a script shim: the SDK falls back to the CLI it bundles.
    expect(sdkExecutablePath(NPM_SHIM, "win32")).toBe(undefined);
    expect(sdkExecutablePath(NPM_SHIM, "win32", SCRIPT_SHIM)).toBe(undefined);
    expect(sdkExecutablePath("/Users/me/.local/bin/claude", "darwin")).toBe(
      "/Users/me/.local/bin/claude",
    );
  });
});

describe("resolveBinary on Windows", () => {
  it("accepts npm's claude.cmd shim when no native claude.exe is installed", async () => {
    const fs = fakeFs({
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd": {
        head: text("@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\n"),
      },
    });
    const resolved = await Effect.runPromise(
      resolveBinary(
        pathCandidates({ Path: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm" }, "win32"),
        fs,
      ),
    );
    expect(resolved.path).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  });
});

const fakeFs = (files: Record<string, { real?: string; head: Uint8Array }>): BinaryFs => ({
  realpath: (path) => {
    const file = files[path];
    return file ? Effect.succeed(file.real ?? path) : Effect.fail(new Error("ENOENT"));
  },
  readHead: (path) => {
    const file = Object.entries(files).find(([p, f]) => (f.real ?? p) === path)?.[1];
    return file ? Effect.succeed(file.head) : Effect.fail(new Error("ENOENT"));
  },
});

const native = bytes(0xcf, 0xfa, 0xed, 0xfe);

describe("resolveBinary", () => {
  it("skips cmux's wrapper and resolves the symlinked native binary", async () => {
    const fs = fakeFs({
      "/Applications/cmux.app/Contents/Resources/bin/claude": { head: CMUX_WRAPPER },
      "/Users/me/.local/bin/claude": {
        real: "/Users/me/.local/share/claude/versions/2.1.273",
        head: native,
      },
    });
    const resolved = await Effect.runPromise(
      resolveBinary(
        [
          "/missing/claude",
          "/Applications/cmux.app/Contents/Resources/bin/claude",
          "/Users/me/.local/bin/claude",
        ],
        fs,
      ),
    );
    expect(resolved).toEqual({
      path: "/Users/me/.local/share/claude/versions/2.1.273",
      skipped: [
        { path: "/Applications/cmux.app/Contents/Resources/bin/claude", reason: "shell wrapper" },
      ],
    });
  });

  it("fails with AgentUnavailable when only wrappers exist", async () => {
    const fs = fakeFs({ "/cmux/claude": { head: CMUX_WRAPPER } });
    const error = await Effect.runPromise(Effect.flip(resolveBinary(["/cmux/claude"], fs)));
    expect(error).toBeInstanceOf(AgentUnavailable);
    expect(error.reason).toBe("claude-not-found");
    expect(error.message).toBe(
      "No claude executable on the login-shell PATH (skipped: /cmux/claude)",
    );
  });
});

describe("versions", () => {
  it("parses the CLI version and derives the SDK-matched one", () => {
    expect(parseCliVersion("2.1.273 (Claude Code)\n")).toBe("2.1.273");
    expect(expectedCliVersion("0.3.273")).toBe("2.1.273");
    expect(expectedCliVersion("1.0.0")).toBeUndefined();
  });

  it("stays quiet for a matching or slightly newer CLI", () => {
    expect(versionWarning("2.1.272", "0.3.272")).toBeUndefined();
    expect(versionWarning("2.1.273", "0.3.272")).toBeUndefined();
    expect(versionWarning("2.1.282", "0.3.272")).toBeUndefined();
  });

  it("warns when the CLI is older than the SDK's matched CLI", () => {
    expect(versionWarning("2.1.271", "0.3.272")).toContain(
      "Claude Code 2.1.271 is older than 2.1.272",
    );
  });

  it("warns when the CLI is more than 10 patches newer", () => {
    expect(versionWarning("2.1.283", "0.3.272")).toContain(
      "Claude Code 2.1.283 is much newer than 2.1.272",
    );
  });

  it("warns on a different major or minor", () => {
    expect(versionWarning("2.2.0", "0.3.272")).toContain(
      "Claude Code 2.2.0 is on a different release line than 2.1.272",
    );
    expect(versionWarning("3.1.272", "0.3.272")).toContain("on a different release line");
  });

  it("knows which CLIs carry a resumed session's cost on from its transcript", () => {
    expect(["2.1.276", "2.0.999", "1.9.300"].map(restoresSessionCost)).toEqual([
      false,
      false,
      false,
    ]);
    expect(["2.1.277", "2.2.0", "3.0.0", undefined].map(restoresSessionCost)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("checkAuthStatus", () => {
  it("accepts individual Pro and Max subscription logins without an organization", () => {
    for (const subscriptionType of ["pro", "max"])
      expect(
        checkAuthStatus(
          JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            apiProvider: "firstParty",
            subscriptionType,
          }),
        ),
      ).toBeUndefined();
  });
  it("accepts a `claude /login` subscription, verbatim from the CLI", () => {
    expect(
      checkAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          analyticsDisabled: true,
          projectsDirectory: "/Users/person/.claude/projects",
          configDirectory: "/Users/person/.claude",
          email: "person@organization.example.invalid",
          orgId: "9b5f65a7-cec0-4fce-b71e-a1ffe0227cae",
          orgName: "Example",
          subscriptionType: "enterprise",
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts the environment's token as Claude Code 2.1.286 reports it, verbatim", () => {
    expect(
      checkAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "oauth_token",
          apiProvider: "firstParty",
          analyticsDisabled: false,
          projectsDirectory: "/home/sb/.claude/projects",
          configDirectory: "/home/sb/.claude",
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts an OAuth token the environment supplies", () => {
    for (const authMethod of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CCR_OAUTH_TOKEN_FILE",
    ]) {
      expect(
        checkAuthStatus(JSON.stringify({ loggedIn: true, authMethod, apiProvider: "firstParty" })),
      ).toBeUndefined();
    }
  });

  it("rejects the key and token sources", () => {
    for (const authMethod of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "apiKeyHelper",
      "none",
    ]) {
      expect(
        checkAuthStatus(JSON.stringify({ loggedIn: true, authMethod, apiProvider: "firstParty" })),
      ).toBe("api-key-auth");
    }
    expect(
      checkAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "apiKeyHelper",
          apiProvider: "firstParty",
          apiKeySource: "api_key_helper",
        }),
      ),
    ).toBe("api-key-auth");
  });

  it("rejects a WIF profile, which isn't a subscription", () => {
    expect(
      checkAuthStatus(
        JSON.stringify({ loggedIn: true, authMethod: "profile", apiProvider: "firstParty" }),
      ),
    ).toBe("api-key-auth");
  });

  it("rejects everything else", () => {
    expect(checkAuthStatus(JSON.stringify({ loggedIn: false }))).toBe("not-logged-in");
    expect(
      checkAuthStatus(
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }),
      ),
    ).toBe("third-party-provider");
    expect(checkAuthStatus("Not logged in")).toBe("unparseable");
  });
});

describe("headless Fast compatibility", () => {
  it("requires the documented CLI floor and fails closed for unknown versions", () => {
    expect(supportsFastControl("2.1.204")).toBe(false);
    expect(supportsFastControl("2.1.205")).toBe(true);
    expect(supportsFastControl("2.1.292")).toBe(true);
    expect(supportsFastControl(undefined)).toBe(false);
  });
});
