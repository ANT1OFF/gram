import { describe, expect, it } from "@effect/vitest";
import type { LaunchChecks, Settings, Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import {
  agentsInUseOf,
  claudeReady,
  claudeSignInOf,
  codexSignInOf,
  inferredAgentOf,
  localAgentsInUseOf,
  makeLaunchChecksCache,
  parseToolVersion,
  runLaunchChecks,
  TESTED_VERSIONS,
  upgradeCommand,
  type LaunchProbe,
} from "./checks.ts";

/** Codex when it is not installed: the tested version and an npm install. */
const AGENTS_MISSING = [
  {
    tool: "codex",
    found: false,
    testedVersion: TESTED_VERSIONS.codex,
    upgradeCommand: `npm i -g @openai/codex@${TESTED_VERSIONS.codex}`,
  },
];

const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
});

const fakeProbe = (
  installed: Readonly<Record<string, string>>,
  outputs: Readonly<Record<string, { status: number; stdout: string; stderr?: string } | "fail">>,
) => {
  const runs: string[] = [];
  let clock = 1000;
  const probe: LaunchProbe = {
    path: Effect.succeed("/opt/bin:/usr/bin"),
    which: (bin, pathValue) => (pathValue === "/opt/bin:/usr/bin" ? installed[bin] : undefined),
    whichAll: (bin, pathValue) => {
      const found = pathValue === "/opt/bin:/usr/bin" ? installed[bin] : undefined;
      return found === undefined ? [] : [found];
    },
    realpath: (path) => path,
    claudeUnusable: () => Effect.succeed(undefined),
    run: (file, args) => {
      const key = [file, ...args].join(" ");
      runs.push(key);
      const output = outputs[key];
      return output === undefined || output === "fail"
        ? Effect.fail(new Error(`no ${key}`))
        : Effect.succeed(output);
    },
    now: () => clock++,
  };
  return { probe, runs };
};

describe("runLaunchChecks", () => {
  it.effect("reports versions and sign-in for installed tools", () =>
    Effect.gen(function* () {
      const { probe } = fakeProbe(
        { claude: "/opt/bin/claude", git: "/usr/bin/git", gh: "/opt/bin/gh" },
        {
          "/opt/bin/claude --version": { status: 0, stdout: "2.1.273 (Claude Code)\n" },
          "/opt/bin/claude auth status --json": { status: 0, stdout: SIGNED_IN },
          "/usr/bin/git --version": { status: 0, stdout: "git version 2.47.1\n" },
          "/opt/bin/gh --version": { status: 0, stdout: "gh version 2.63.0 (2024-11-27)\n" },
          "/opt/bin/gh auth status": { status: 0, stdout: "" },
        },
      );
      expect(yield* runLaunchChecks(probe)).toEqual({
        checkedAt: 1000,
        tools: [
          { tool: "claude", found: true, path: "/opt/bin/claude", version: "2.1.273" },
          { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
          { tool: "gh", found: true, path: "/opt/bin/gh", version: "2.63.0" },
          ...AGENTS_MISSING,
        ],
        claudeSignIn: "signedIn",
        codexSignIn: "unknown",
        ghSignedIn: true,
      });
    }),
  );

  it.effect("finds an agent the way its sessions do, past a shell wrapper", () =>
    Effect.gen(function* () {
      const { probe } = fakeProbe(
        { claude: "/opt/bin/claude" },
        {
          "/Users/me/.local/share/claude/versions/2.1.284 --version": {
            status: 0,
            stdout: "2.1.284 (Claude Code)\n",
          },
        },
      );
      const checks = yield* runLaunchChecks({
        ...probe,
        // cmux's wrapper is first on the PATH; the adapter's choice is the native install after it.
        agentBinary: (agent) =>
          Effect.succeed(
            agent === "claude" ? "/Users/me/.local/share/claude/versions/2.1.284" : undefined,
          ),
      });
      expect(checks.tools[0]).toEqual({
        tool: "claude",
        found: true,
        path: "/Users/me/.local/share/claude/versions/2.1.284",
        version: "2.1.284",
      });
    }),
  );

  it.effect("degrades missing tools and failing commands instead of failing", () =>
    Effect.gen(function* () {
      const { probe, runs } = fakeProbe(
        { claude: "/opt/bin/claude", git: "/usr/bin/git" },
        {
          "/opt/bin/claude --version": "fail",
          "/opt/bin/claude auth status --json": {
            status: 1,
            stdout: JSON.stringify({ loggedIn: false }),
          },
          "/usr/bin/git --version": { status: 0, stdout: "git version 2.47.1\n" },
        },
      );
      const checks = yield* runLaunchChecks(probe);
      expect(checks.tools).toEqual([
        { tool: "claude", found: true, path: "/opt/bin/claude" },
        { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
        { tool: "gh", found: false },
        ...AGENTS_MISSING,
      ]);
      expect(checks.claudeSignIn).toBe("notSignedIn");
      expect(checks.ghSignedIn).toBe(false);
      expect(runs.some((run) => run.startsWith("gh"))).toBe(false);
    }),
  );

  it.effect("marks a Claude found on PATH unusable when no thread could start from it", () =>
    Effect.gen(function* () {
      const reason =
        "C:\\npm\\claude.cmd doesn't run a native claude.exe, which Claude threads need.";
      const { probe } = fakeProbe(
        { claude: "C:\\npm\\claude.cmd", git: "/usr/bin/git" },
        {
          "C:\\npm\\claude.cmd --version": { status: 0, stdout: "2.1.273 (Claude Code)\n" },
          "C:\\npm\\claude.cmd auth status --json": { status: 0, stdout: SIGNED_IN },
          "/usr/bin/git --version": { status: 0, stdout: "git version 2.47.1\n" },
        },
      );
      const asked: string[] = [];
      const checks = yield* runLaunchChecks({
        ...probe,
        claudeUnusable: (path) => {
          asked.push(path);
          return Effect.succeed(reason);
        },
      });
      expect(checks.tools[0]).toEqual({
        tool: "claude",
        found: true,
        path: "C:\\npm\\claude.cmd",
        version: "2.1.273",
        unusable: reason,
      });
      expect(checks.tools[1]).toEqual({
        tool: "git",
        found: true,
        path: "/usr/bin/git",
        version: "2.47.1",
      });
      expect(asked).toEqual(["C:\\npm\\claude.cmd"]);
    }),
  );

  it.effect("logs the verdict and nothing of what `claude auth status` printed", () =>
    Effect.gen(function* () {
      const { probe } = fakeProbe(
        { claude: "C:\\npm\\claude.cmd" },
        {
          "C:\\npm\\claude.cmd --version": { status: 0, stdout: "2.1.273 (Claude Code)\n" },
          "C:\\npm\\claude.cmd auth status --json": {
            status: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authMethod: "ANTHROPIC_AUTH_TOKEN",
              email: "tester@organization.example.invalid",
              orgId: "org-planted",
            }),
          },
        },
      );
      const lines: Array<Record<string, unknown>> = [];
      const capture = Logger.make(({ message, fiber }) => {
        lines.push({ message, ...fiber.getRef(References.CurrentLogAnnotations) });
      });
      yield* runLaunchChecks(probe).pipe(Effect.provide(Logger.layer([capture])));
      expect(lines).toEqual([
        {
          message: ["launch checks"],
          claudeUsable: true,
          claudeSignIn: "apiKey",
          codexSignIn: "unknown",
          ghSignedIn: false,
          tools: "claude=C:\\npm\\claude.cmd@2.1.273 git=missing@? gh=missing@? codex=missing@?",
        },
      ]);
      expect(JSON.stringify(lines)).not.toMatch(/tester@|org-planted|ANTHROPIC_AUTH_TOKEN/);
    }),
  );
});

describe("makeLaunchChecksCache", () => {
  it.effect("runs once, shares the result, and re-runs on refresh", () =>
    Effect.gen(function* () {
      const { probe, runs } = fakeProbe(
        { git: "/usr/bin/git" },
        {
          "/usr/bin/git --version": { status: 0, stdout: "git version 2.47.1" },
        },
      );
      const get = yield* makeLaunchChecksCache(probe);
      const [first, second] = yield* Effect.all([get(false), get(false)], {
        concurrency: "unbounded",
      });
      expect(second).toBe(first);
      expect(runs).toEqual(["/usr/bin/git --version"]);

      const refreshed = yield* get(true);
      expect(refreshed.checkedAt).toBeGreaterThan(first.checkedAt);
      expect(runs).toHaveLength(2);
      expect(yield* get(false)).toBe(refreshed);
    }),
  );
});

describe("parsers", () => {
  it("takes the first x.y.z and maps auth problems to sign-in states", () => {
    expect(parseToolVersion("no digits")).toBeUndefined();
    expect(parseToolVersion("codex-cli 0.160.0-alpha.3\n")).toBe("0.160.0-alpha.3");
    expect(parseToolVersion("git version 2.47.1 (Apple Git-154)")).toBe("2.47.1");
    expect(parseToolVersion("git version 2.47.1.windows.1")).toBe("2.47.1");
    expect(parseToolVersion("2.1.273 (Claude Code)")).toBe("2.1.273");
    expect(claudeSignInOf(SIGNED_IN)).toBe("signedIn");
    expect(
      claudeSignInOf(JSON.stringify({ loggedIn: true, authMethod: "ANTHROPIC_API_KEY" })),
    ).toBe("apiKey");
    expect(claudeSignInOf("not json")).toBe("unknown");
  });

  it("calls Claude ready only when a usable CLI is signed in", () => {
    const claude = { tool: "claude", found: true, path: "/usr/bin/claude" } as const;
    const checks = {
      checkedAt: 0,
      tools: [claude],
      claudeSignIn: "signedIn",
      ghSignedIn: true,
    } as const;
    expect(claudeReady(checks)).toBe(true);
    expect(claudeReady({ ...checks, claudeSignIn: "apiKey" })).toBe(false);
    expect(claudeReady({ ...checks, tools: [{ ...claude, unusable: "no claude.exe" }] })).toBe(
      false,
    );
    expect(claudeReady({ ...checks, tools: [{ tool: "claude", found: false }] })).toBe(false);
  });
});

/** Launch checks with only the agents named installed, each signed in. */
const installed = (...agents: Array<"claude" | "codex">): LaunchChecks => ({
  checkedAt: 0,
  tools: (["claude", "codex", "git"] as const).map((tool) => ({
    tool,
    found: tool === "git" || agents.includes(tool as "claude" | "codex"),
  })),
  claudeSignIn: agents.includes("claude") ? "signedIn" : "unknown",
  codexSignIn: agents.includes("codex") ? "signedIn" : "unknown",
  ghSignedIn: false,
});
const codexOnly = installed("codex");
const both = installed("claude", "codex");
const neither = installed();

/** Just enough settings for `agentsInUseOf`: the default model's agent, if any. */
const settings = (agent?: string) =>
  ({
    agents: agent === undefined ? {} : { defaultModel: { agent, model: "m" } },
  }) as unknown as Settings;

const threads = (...agents: string[]) =>
  agents.map((agent) => ({ model: { agent, model: "m" } })) as unknown as Thread[];

describe("gateway agent CLIs", () => {
  it.effect(
    "reports an installed Codex's version against the tested one, with a brew upgrade",
    () =>
      Effect.gen(function* () {
        const { probe } = fakeProbe(
          { codex: "/opt/bin/codex" },
          { "/opt/bin/codex --version": { status: 0, stdout: "codex-cli 0.153.4\n" } },
        );
        const checks = yield* runLaunchChecks({
          ...probe,
          realpath: (path) =>
            path === "/opt/bin/codex" ? "/opt/homebrew/Cellar/codex/0.153.4/bin/codex" : path,
        });
        expect(checks.tools.find((t) => t.tool === "codex")).toEqual({
          tool: "codex",
          found: true,
          path: "/opt/bin/codex",
          version: "0.153.4",
          testedVersion: TESTED_VERSIONS.codex,
          upgradeCommand: "brew upgrade codex",
        });
      }),
  );

  it("names the upgrade for how each binary was installed", () => {
    expect(
      upgradeCommand(
        "codex",
        "/Users/me/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex",
        "0.160.1",
      ),
    ).toBeUndefined();
    expect(
      upgradeCommand("codex", "/Applications/Example.app/Contents/Resources/codex", "0.160.1"),
    ).toBeUndefined();
    const npmCodex = "/usr/local/nvm/versions/node/v25/lib/node_modules/@openai/codex/bin/codex.js";
    expect(upgradeCommand("codex", npmCodex, "0.154.0")).toBe("npm i -g @openai/codex@0.154.0");
    expect(upgradeCommand("codex", undefined, "0.154.0")).toBe("npm i -g @openai/codex@0.154.0");
    expect(
      upgradeCommand(
        "codex",
        "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
        "0.154.0",
      ),
    ).toBe("npm i -g @openai/codex@0.154.0");

    expect(
      upgradeCommand("codex", "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", "0.154.0"),
    ).toBe("npm i -g @openai/codex@0.154.0");
  });

  it("counts only agents selected as defaults or used in threads", () => {
    expect(agentsInUseOf(settings(), threads("claude"), neither)).toEqual([]);
    expect(agentsInUseOf(settings("claude"), [], codexOnly)).toEqual([]);
    expect(agentsInUseOf(settings(), [], neither)).toEqual([]);
    expect(agentsInUseOf(settings("codex"), [], neither)).toEqual(["codex"]);
  });

  it("with no default saved, counts the Codex new threads would start on", () => {
    expect(agentsInUseOf(settings(), [], codexOnly)).toEqual(["codex"]);
    expect(agentsInUseOf(settings(), [], both)).toEqual([]);
  });
});

describe("Codex subscription status", () => {
  it("classifies stdout or stderr without exposing a key, and treats failures as unknown", () => {
    expect(codexSignInOf({ status: 0, stdout: "", stderr: "Logged in using ChatGPT\n" })).toBe(
      "signedIn",
    );
    expect(codexSignInOf({ status: 0, stdout: "Logged in using ChatGPT\n" })).toBe("signedIn");
    expect(
      codexSignInOf({
        status: 0,
        stdout: "",
        stderr: "Logged in using an API key - synthetic-masked-key",
      }),
    ).toBe("apiKey");
    expect(codexSignInOf({ status: 1, stdout: "", stderr: "Not logged in\n" })).toBe("notSignedIn");
    expect(codexSignInOf({ status: 1, stdout: "Logged in using ChatGPT" })).toBe("unknown");
    expect(codexSignInOf({ status: 0, stdout: "Logged in using access token" })).toBe("unknown");
    expect(codexSignInOf({ status: 1, stdout: "could not open auth store" })).toBe("unknown");
  });

  it.effect("queries the selected CLI's login status and logs only the classification", () =>
    Effect.gen(function* () {
      const { probe, runs } = fakeProbe(
        { codex: "/opt/bin/codex" },
        {
          "/opt/bin/codex --version": { status: 0, stdout: "codex-cli 0.160.1" },
          "/opt/bin/codex login status": {
            status: 0,
            stdout: "",
            stderr: "Logged in using an API key - planted-masked-key",
          },
        },
      );
      const lines: unknown[] = [];
      const logger = Logger.make(({ message, fiber }) =>
        lines.push({ message, ...fiber.getRef(References.CurrentLogAnnotations) }),
      );
      const checks = yield* runLaunchChecks(probe).pipe(Effect.provide(Logger.layer([logger])));
      expect(checks.codexSignIn).toBe("apiKey");
      expect(runs).toContain("/opt/bin/codex login status");
      expect(JSON.stringify(lines)).not.toContain("planted-masked-key");
    }),
  );

  it("distinguishes the user's own workflows from gateway threads", () => {
    const gatewayThread = {
      model: { agent: "codex", model: "m", profileId: "gateway" },
    } as unknown as Thread;
    expect(localAgentsInUseOf(settings("codex"), [gatewayThread], both)).toEqual(["codex"]);
    const gatewayDefault = { agents: { defaultModel: gatewayThread.model } } as unknown as Settings;
    expect(localAgentsInUseOf(gatewayDefault, [gatewayThread], both)).toEqual([]);
    expect(localAgentsInUseOf(settings("codex"), threads("codex"), both)).toEqual(["codex"]);
    expect(localAgentsInUseOf(settings(), [], both)).toEqual(["claude"]);
  });

  it("with no default saved, infers the agent in use from the CLIs installed and signed in", () => {
    // A Codex-only user isn't told Claude Code is missing.
    expect(localAgentsInUseOf(settings(), [], codexOnly)).toEqual(["codex"]);
    expect(inferredAgentOf(codexOnly)).toBe("codex");
    // Signed in beats installed, Claude Code first, as discovery picks.
    expect(inferredAgentOf(both)).toBe("claude");
    expect(inferredAgentOf({ ...both, claudeSignIn: "notSignedIn" })).toBe("codex");
    expect(inferredAgentOf({ ...both, claudeSignIn: "notSignedIn", codexSignIn: "apiKey" })).toBe(
      "claude",
    );
    expect(inferredAgentOf({ ...codexOnly, codexSignIn: "notSignedIn" })).toBe("codex");
    expect(inferredAgentOf(neither)).toBeUndefined();
    expect(localAgentsInUseOf(settings(), [], neither)).toEqual([]);
    // A saved default or a thread still counts, whatever is installed.
    expect(localAgentsInUseOf(settings("claude"), [], codexOnly)).toEqual(["claude"]);
    expect(localAgentsInUseOf(settings(), threads("claude"), codexOnly)).toEqual([
      "claude",
      "codex",
    ]);
  });
});
