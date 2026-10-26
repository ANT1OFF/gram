import { describe, expect, it } from "@effect/vitest";
import { CLAUDE_AGENT_SDK_VERSION } from "@gram/agents/claude";
import { CODEX_CLI_VERSION } from "@gram/agents/codex";
import type {
  AgentRuntime,
  CliUpdateState,
  LaunchChecks,
  ManagedInstall,
  RuntimeAgent,
} from "@gram/contracts";
import {
  ProcSpawnError,
  ProcTimeout,
  type ProcError,
  type ProcOutput,
  type RunOptions,
} from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import {
  makeCliUpdates,
  OUTPUT_TAIL_CHARS,
  tidyOutput,
  updateArgv,
  updateFailure,
  type CliUpdatesDeps,
} from "./cli-update.ts";
import {
  REGISTRY_SIGN_IN_EXPIRED,
  REGISTRY_UNREADABLE,
  refusedForAge,
  refusedSignIn,
} from "./npm-registry.ts";
import {
  BASELINES,
  compareVersions,
  installerOf,
  installSteps,
  judgeAgainstBaseline,
} from "./policy.ts";
import {
  latestOf,
  makeVendorReleases,
  NPM_VIEW_MS,
  NpmViewError,
  npmView,
  publishedAtOf,
  type VendorReleases,
} from "./releases.ts";
import { RELEASE_AGE_MS, resolveAgentRuntimes, type ResolveInput } from "./resolve.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const CODEX = BASELINES.codex.cliVersion;
const CLAUDE = BASELINES.claude.cliVersion;
const NATIVE = CLAUDE;

/** `x.y.z` with its patch moved by `by`. */
const patch = (version: string, by: number) => {
  const [major, minor, p] = version.split(".").map(Number);
  return `${major}.${minor}.${p! + by}`;
};
const minor = (version: string, by: number) => {
  const [major, m] = version.split(".").map(Number);
  return `${major}.${m! + by}.0`;
};

const checks = (tools: LaunchChecks["tools"]): LaunchChecks => ({
  checkedAt: NOW - 1,
  tools,
  claudeSignIn: "signedIn",
  ghSignedIn: true,
});

const input = (overrides: Partial<ResolveInput> = {}): ResolveInput => ({
  checks: checks([
    { tool: "claude", found: true, path: "/Users/me/.local/bin/claude", version: CLAUDE },
    { tool: "codex", found: true, path: "/opt/homebrew/bin/codex", version: CODEX },
  ]),
  releases: { releases: {} },
  platform: "darwin",
  now: NOW,
  realpath: (path) =>
    path === "/opt/homebrew/bin/codex"
      ? "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"
      : path === "/Users/me/.local/bin/claude"
        ? `/Users/me/.local/share/claude/versions/${CLAUDE}`
        : path,
  npmPackageBeside: () => false,
  ...overrides,
});

const VIEW = (latest: string, time: Record<string, string>) => ({
  "dist-tags": { latest, alpha: "0.161.0-alpha.13" },
  time: { created: "2025-01-01T00:00:00Z", ...time },
});

const released = (agent: RuntimeAgent, version: string, ageHours: number): VendorReleases => ({
  checkedAt: NOW,
  releases: { [agent]: { version, publishedAt: NOW - ageHours * HOUR } },
});

const run = (overrides: Partial<ResolveInput> = {}) =>
  resolveAgentRuntimes(input(overrides)).pipe(
    Effect.map((all) => Object.fromEntries(all.agents.map((a) => [a.agent, a]))),
  );

/** Each step's command and the argv it runs, if any. */
const runs = (...args: Parameters<typeof installSteps>) =>
  installSteps(...args).map((step) => [step.command, step.run]);

/** Which problem an update failing with `output` is. */
const fail = (installer: Parameters<typeof updateFailure>[1], output: string) =>
  updateFailure("claude", installer, "npm i -g @anthropic-ai/claude-code@1.19.0", 1, output)
    .problem;

const STEP_COMMAND = "claude update";
const nativeRow = (version: string): AgentRuntime => ({
  agent: "claude",
  resolved: { source: "path", path: "/Users/me/.local/bin/claude", version },
  baseline: BASELINES.claude,
  verdict: "supported",
  installSteps: installSteps("claude", "native", "1.19.0", "darwin", true),
});

const exitWith = (status: number, stdout = "", stderr = ""): ProcOutput => ({
  status,
  stdout,
  stderr,
  truncated: false,
});

/** An updater over fakes; `gate` holds each run until it's completed. */
const updater = (exit: () => Effect.Effect<ProcOutput, ProcError>) =>
  Effect.gen(function* () {
    const calls = { runs: [] as Array<ReadonlyArray<string>>, updated: 0, reprobes: 0 };
    const gate = yield* Deferred.make<void>();
    let version = "1.18.29";
    const deps: CliUpdatesDeps = {
      runtime: (agent) => Effect.succeed(agent === "claude" ? nativeRow(version) : undefined),
      run: (argv, onOutput) =>
        Effect.gen(function* () {
          calls.runs.push(argv);
          onOutput("Upgrading claude\n");
          yield* Deferred.await(gate);
          const out = yield* exit();
          if (out.status === 0) version = "1.19.0";
          onOutput(out.stdout);
          return out;
        }),
      reprobe: () =>
        Effect.sync(() => {
          calls.reprobes++;
          return version;
        }),
      runningThreads: () => Effect.succeed(2),
      updated: () =>
        Effect.sync(() => {
          calls.updated++;
        }),
      now: () => NOW,
    };
    const updates = yield* makeCliUpdates(deps);
    return { updates, calls, gate };
  });

const settled = (updates: Effect.Success<ReturnType<typeof updater>>["updates"]) =>
  updates.watch("claude").pipe(
    Stream.filter((state) => state.state !== "running"),
    Stream.runHead,
    Effect.map((head) => head as unknown as { value: CliUpdateState }),
  );

describe("agent runtime policy", () => {
  it("judges each agent against its own baseline", () => {
    expect(judgeAgainstBaseline("codex", CODEX).verdict).toBe("supported");
    expect(judgeAgainstBaseline("codex", patch(CODEX, 5)).verdict).toBe("supported");
    expect(judgeAgainstBaseline("codex", patch(CODEX, -1)).verdict).toBe("graceful");
    expect(judgeAgainstBaseline("codex", minor(CODEX, -1)).verdict).toBe("unsupported");
    expect(judgeAgainstBaseline("codex", minor(CODEX, 1)).verdict).toBe("unknown");
    expect(judgeAgainstBaseline("codex", `${minor(CODEX, 1)}-alpha.2`).verdict).toBe("unknown");
    // Claude's SDK pairs a CLI line, and allows ten patches past it.
    expect(BASELINES.claude.cliVersion).toMatch(/^2\.1\.\d+$/);
    expect(judgeAgainstBaseline("claude", patch(CLAUDE, 10)).verdict).toBe("supported");
    expect(judgeAgainstBaseline("claude", patch(CLAUDE, 11))).toMatchObject({
      verdict: "unknown",
      reason: expect.stringContaining("hasn't been checked"),
    });
    expect(judgeAgainstBaseline("claude", patch(NATIVE, 1)).verdict).toBe("supported");
    expect(compareVersions("0.160.0-alpha.1", "0.160.0")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("reads the installer off the path, npm winning over a Homebrew Node", () => {
    const cases: Array<[RuntimeAgent, string, string, boolean, string]> = [
      [
        "codex",
        "/opt/homebrew/bin/codex",
        "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
        false,
        "npm",
      ],
      [
        "codex",
        "/opt/homebrew/bin/codex",
        "/opt/homebrew/Cellar/codex/0.159.2/bin/codex",
        false,
        "brew",
      ],
      [
        "claude",
        "/opt/homebrew/bin/claude",
        "/opt/homebrew/Caskroom/claude-code/2.1.284/claude",
        false,
        "brew",
      ],
      [
        "claude",
        "/Users/me/.local/bin/claude",
        "/Users/me/.local/share/claude/versions/2.1.284",
        false,
        "native",
      ],
      ["claude", "/Users/me/.local/bin/claude", "/Users/me/.local/bin/claude", false, "native"],
      [
        "codex",
        "/Users/me/Library/pnpm/codex",
        "/Users/me/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
        false,
        "pnpm",
      ],
      [
        "codex",
        "/Users/me/.bun/bin/codex",
        "/Users/me/.bun/install/global/node_modules/@openai/codex/bin/codex.js",
        false,
        "bun",
      ],
      // Windows: a shim has no symlink to follow; npm's package sits beside it.
      [
        "codex",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
        true,
        "npm",
      ],
      [
        "claude",
        "C:\\Users\\me\\.local\\bin\\claude.exe",
        "C:\\Users\\me\\.local\\bin\\claude.exe",
        false,
        "native",
      ],
      ["codex", "C:\\tools\\codex.exe", "C:\\tools\\codex.exe", false, "unknown"],
    ];
    for (const [agent, path, resolved, beside, installer] of cases)
      expect(installerOf(agent, path, resolved, beside), path).toBe(installer);
  });

  it("gives an exact command per installer, with npm as the fallback", () => {
    expect(installSteps("codex", "npm", "0.159.4", "darwin", true)).toEqual([
      {
        installer: "npm",
        command: "npm i -g @openai/codex@0.159.4",
        exact: true,
        version: "0.159.4",
        run: ["npm", "i", "-g", "@openai/codex@0.159.4"],
      },
    ]);
    expect(
      installSteps("codex", "brew", "0.159.4", "darwin", true).map((s) => [s.command, s.exact]),
    ).toEqual([
      ["brew upgrade codex", false],
      ["npm i -g @openai/codex@0.159.4", true],
    ]);
    expect(installSteps("claude", "native", "2.1.290", "darwin", true)[0]).toMatchObject({
      command: "claude update",
      exact: false,
    });
    expect(installSteps("claude", undefined, "2.1.290", "win32", false)[0]!.command).toContain(
      "install.ps1))) 2.1.290",
    );
    expect(installSteps("claude", undefined, "2.1.290", "darwin", false)[0]!.command).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.290",
    );
    expect(installSteps("codex", "pnpm", "0.159.4", "darwin", false)[0]!.command).toBe(
      "pnpm add -g @openai/codex@0.159.4",
    );
  });

  it("runs only a plain command for the installer that's there, never a pipeline", () => {
    // The installer's own command runs as its argv, which is the command as shown.
    expect(runs("claude", "native", "1.19.0", "darwin", true)).toEqual([
      ["claude update", ["claude", "update"]],
      ["npm i -g @anthropic-ai/claude-code@1.19.0", undefined],
    ]);
    expect(runs("claude", "native", "2.1.290", "win32", true)[0]).toEqual([
      "claude update",
      ["claude", "update"],
    ]);
    expect(runs("codex", "bun", "0.159.4", "darwin", false)[0]![1]).toEqual([
      "bun",
      "add",
      "-g",
      "@openai/codex@0.159.4",
    ]);
    expect(runs("claude", "brew", "2.1.290", "darwin", true)[0]![1]).toEqual([
      "brew",
      "upgrade",
      "--cask",
      "claude-code",
    ]);
    // Claude Code's installer pipelines need a shell and run a remote script: copy-only.
    for (const platform of ["darwin", "win32"] as const) {
      const [installer, npm] = installSteps("claude", "native", "2.1.290", platform, false);
      expect(installer!.command).toMatch(/\| bash|irm/);
      expect(installer).not.toHaveProperty("run");
      expect(npm).not.toHaveProperty("run");
    }
    // npm where it didn't put the CLI would add a second install beside the one in use.
    expect(runs("codex", "unknown", "0.159.4", "darwin", false)).toEqual([
      ["npm i -g @openai/codex@0.159.4", undefined],
    ]);
    expect(runs("codex", "brew", "0.159.4", "darwin", false)).toEqual([
      ["npm i -g @openai/codex@0.159.4", undefined],
    ]);
    // Nothing installed: npm's install is the only one there will be.
    expect(runs("codex", undefined, "1.19.0", "darwin", false)).toEqual([
      ["npm i -g @openai/codex@1.19.0", ["npm", "i", "-g", "@openai/codex@1.19.0"]],
    ]);
    expect(runs("claude", undefined, "2.1.290", "darwin", false).map(([, r]) => r)).toEqual([
      undefined,
      ["npm", "i", "-g", "@anthropic-ai/claude-code@2.1.290"],
    ]);
    // Every runnable command is its argv joined, so what the user confirms is what runs.
    for (const installer of ["npm", "pnpm", "bun", "brew", "native"] as const)
      for (const step of installSteps("claude", installer, "1.19.0", "darwin", true))
        if (step.run !== undefined) expect(step.run.join(" ")).toBe(step.command);
  });
});

describe("updating the user's own CLI", () => {
  it.effect(
    "identifies standalone Codex and offers its updater only for an eligible qualified latest",
    () =>
      Effect.gen(function* () {
        const path = "/Users/me/.local/bin/codex";
        const real = `/Users/me/.codex/packages/standalone/releases/${CODEX}-aarch64-apple-darwin/bin/codex`;
        const installed = checks([{ tool: "codex", found: true, path, version: patch(CODEX, -1) }]);
        const own = { checks: installed, realpath: () => real };
        const baselineOnly = (yield* run(own))["codex"]!;
        expect(baselineOnly.installation).toMatchObject({ installer: "native", realPath: real });
        expect(baselineOnly.installation?.updateNote).toContain("cannot pin a version");
        expect(baselineOnly.installSteps).toEqual([]);
        // Neither an unqualified newer line nor a release still waiting may run a latest-only update.
        for (const releases of [
          released("codex", minor(CODEX, 1), 48),
          released("codex", CODEX, 1),
        ])
          expect((yield* run({ ...own, releases }))["codex"]!.installSteps).toEqual([]);
        const ready = (yield* run({ ...own, releases: released("codex", CODEX, 48) }))["codex"]!;
        expect(ready.installSteps).toEqual([
          { installer: "native", command: "codex update", exact: false, run: ["codex", "update"] },
        ]);
        expect(updateArgv("native", ready.installSteps[0]!.run!, ready)).toEqual([path, "update"]);
        expect(ready.installation?.updateNote).toBeUndefined();
      }),
  );

  it.effect(
    "does not offer an in-place update or npm fallback over Nix, bundled or read-only CLIs",
    () =>
      Effect.gen(function* () {
        const path = "/Users/me/.local/bin/claude";
        const targets = [
          ["/nix/store/synthetic-claude-1.18.9/bin/claude", "nix", "Nix owns"],
          ["/Applications/Example.app/Contents/Resources/claude", "bundled", "belongs to an app"],
          [path, "native", "read-only"],
        ];
        for (const [real, installer, note] of targets) {
          const row = (yield* run({
            checks: checks([{ tool: "claude", found: true, path, version: patch(NATIVE, -1) }]),
            realpath: () => real!,
            writable: () => false,
            releases: released("claude", NATIVE, 48),
          }))["claude"]!;
          expect(row.installation?.installer).toBe(installer);
          expect(row.installation?.updateNote).toContain(note!);
          expect(row.installSteps).toEqual([]);
        }
        // The newer daemon copy is not the standalone install's owner.
        expect(
          installerOf(
            "codex",
            "/Users/me/.local/bin/codex",
            "/Users/me/.codex/packages/app-server-daemon/releases/0.162.1-aarch64-apple-darwin/bin/codex",
            false,
          ),
        ).toBe("bundled");
        // Destination ownership takes precedence over misleading Bun/npm launcher locations.
        expect(
          installerOf(
            "codex",
            "/Users/me/.bun/bin/codex",
            "/nix/store/synthetic/node_modules/@openai/codex/bin/codex.js",
            false,
          ),
        ).toBe("nix");
      }),
  );

  it.live("refuses update requests for a Nix-owned runtime without starting a process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const row = (yield* run({
          checks: checks([
            { tool: "claude", found: true, path: "/etc/profiles/per-user/me/bin/claude" },
          ]),
          realpath: () => "/nix/store/synthetic-claude/bin/claude",
        }))["claude"]!;
        let processRuns = 0;
        const updates = yield* makeCliUpdates({
          runtime: () => Effect.succeed(row),
          run: () => {
            processRuns++;
            return Effect.succeed(exitWith(0));
          },
          reprobe: () => Effect.undefined,
          runningThreads: () => Effect.succeed(0),
          updated: () => Effect.void,
          now: () => NOW,
        });
        for (const command of ["claude update", "npm i -g @anthropic-ai/claude-code@1.19.0"]) {
          expect((yield* Effect.flip(updates.start("claude", command))).reason).toBe("not-offered");
        }
        expect(processRuns).toBe(0);
      }),
    ),
  );

  it("tells the registry's refusal, the release-age hold and a missing permission apart", () => {
    expect(fail("npm", "npm error code E401\nnpm error 401 Unauthorized - GET https://x")).toBe(
      "sign-in",
    );
    expect(
      updateFailure(
        "codex",
        "pnpm",
        "pnpm add -g x",
        1,
        "ERR_PNPM_FETCH_403 GET …: Forbidden - 403",
      ).message,
    ).toBe(`${REGISTRY_SIGN_IN_EXPIRED}, then try again.`);
    expect(fail("npm", "npm error code ETARGET\nnpm error notarget No matching version")).toBe(
      "release-age",
    );
    expect(fail("npm", "npm error code EACCES\nnpm error syscall mkdir")).toBe("permission");
    expect(fail("brew", "Error: Permission denied @ rb_sysopen")).toBe("permission");
    expect(fail("npm", "npm error code EBUSY\nnpm error syscall rename")).toBe("in-use");
    // A 401 from a vendor's own updater isn't the npm registry's sign-in.
    expect(fail("native", "error: 403 Forbidden")).toBe("failed");
    expect(updateFailure("claude", "native", "claude update", 2, "boom").message).toContain(
      "exit code 2",
    );
    // The permission message offers no sudo, only the user's own terminal.
    expect(updateFailure("codex", "npm", "c", 1, "EACCES").message).toContain(
      "never asks for sudo",
    );
  });

  it("runs a CLI's own updater as the resolved executable, and a package manager by name", () => {
    const row = nativeRow("1.18.29");
    expect(updateArgv("native", ["claude", "update"], row)).toEqual([
      "/Users/me/.local/bin/claude",
      "update",
    ]);
    expect(updateArgv("npm", ["npm", "i", "-g", "@anthropic-ai/claude-code@1.19.0"], row)[0]).toBe(
      "npm",
    );
    // A managed runtime isn't the user's to update.
    const managed: AgentRuntime = {
      ...row,
      resolved: { source: "managed", path: "/store/claude", version: "1.18.29" },
    };
    expect(updateArgv("native", ["claude", "update"], managed)[0]).toBe("claude");
  });

  it("tidies output into a scrubbed tail", () => {
    expect(tidyOutput("\u001b[32mok\u001b[0m\r\n")).toBe("ok\n");
    // A spinner's redraws keep their last frame.
    expect(tidyOutput("⠋ fetching\r⠙ fetching\rdone\nnext")).toBe("done\nnext");
    expect(tidyOutput("GET https://me:hunter2@registry.example/npm/x")).toBe(
      "GET https://[redacted]@registry.example/npm/x",
    );
    expect(tidyOutput("//registry/:_authToken=abc123def")).not.toContain("abc123def");
    const long = tidyOutput(`${"line\n".repeat(OUTPUT_TAIL_CHARS)}last`);
    expect(long.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
    expect(long.startsWith("line\n")).toBe(true);
    expect(long.endsWith("last")).toBe(true);
  });

  it.live("runs only what the listing offers, one at a time, then probes the CLI again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { updates, calls, gate } = yield* updater(() =>
          Effect.succeed(exitWith(0, "Upgraded to 1.19.0\n")),
        );
        const refused = yield* Effect.flip(updates.start("claude", "claude upgrade 9.9.9"));
        expect(refused.reason).toBe("not-offered");
        // The copy-only fallback isn't run either.
        const fallback = yield* Effect.flip(
          updates.start("claude", "npm i -g @anthropic-ai/claude-code@1.19.0"),
        );
        expect(fallback.reason).toBe("not-offered");
        expect(calls.runs).toEqual([]);

        const started = yield* updates.start("claude", STEP_COMMAND);
        expect(started).toMatchObject({
          state: "running",
          command: STEP_COMMAND,
          runningThreads: 2,
        });
        const busy = yield* Effect.flip(updates.start("claude", STEP_COMMAND));
        expect(busy.reason).toBe("busy");
        // The CLI's own updater runs as the executable the row resolved, not the bare name.
        expect(calls.runs).toEqual([["/Users/me/.local/bin/claude", "update"]]);
        // Output reaches watchers while the run goes on.
        const live = yield* updates.watch("claude").pipe(
          Stream.filter((s) => s.state === "running" && s.output.includes("Upgrading")),
          Stream.runHead,
        );
        expect(live._tag).toBe("Some");

        const done = yield* Effect.forkScoped(
          updates.watch("claude").pipe(
            Stream.filter((s) => s.state !== "running"),
            Stream.runHead,
          ),
        );
        yield* Deferred.succeed(gate, undefined);
        const outcome = yield* Fiber.join(done);
        expect(outcome._tag === "Some" && outcome.value).toEqual({
          state: "succeeded",
          command: STEP_COMMAND,
          output: "Upgrading claude\nUpgraded to 1.19.0\n",
          from: "1.18.29",
          version: "1.19.0",
          runningThreads: 2,
        });
        expect(calls).toMatchObject({ updated: 1, reprobes: 1 });
        // Dismissing the outcome is a cancel with nothing running.
        expect(yield* updates.cancel("claude")).toEqual({ state: "idle" });
      }),
    ),
  );

  it.live("says why a run failed, and a cancel kills it without leaving it running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let next: Effect.Effect<ProcOutput, ProcError> = Effect.succeed(
          exitWith(1, "", "npm error code E401"),
        );
        const { updates, calls, gate } = yield* updater(() => next);
        // Not npm: a native updater's 401 isn't the registry's sign-in.
        yield* updates.start("claude", STEP_COMMAND);
        yield* Deferred.succeed(gate, undefined);
        const failed = yield* settled(updates);
        expect(failed.value).toMatchObject({ state: "failed", problem: "failed" });

        next = Effect.fail(new ProcTimeout({ bin: "claude", message: "claude timed out" }));
        yield* updates.start("claude", STEP_COMMAND);
        expect((yield* settled(updates)).value).toMatchObject({ problem: "timeout" });

        next = Effect.fail(new ProcSpawnError({ bin: "claude", message: "ENOENT" }));
        yield* updates.start("claude", STEP_COMMAND);
        expect((yield* settled(updates)).value).toMatchObject({ problem: "missing" });
        expect(calls.updated).toBe(0);

        next = Effect.never;
        yield* updates.start("claude", STEP_COMMAND);
        const cancelled = yield* updates.cancel("claude");
        expect(cancelled).toMatchObject({ state: "failed", problem: "cancelled" });
        // Free again: the next one starts.
        expect((yield* updates.start("claude", STEP_COMMAND)).state).toBe("running");
        expect(calls.updated).toBe(0);
      }),
    ),
  );
});

describe("vendor releases", () => {
  it("reads the latest tag and its publication time off npm's answer", () => {
    const view = VIEW("0.159.3", { "0.159.3": "2026-09-30T23:02:02.182Z" });
    expect(latestOf(view)).toBe("0.159.3");
    expect(publishedAtOf(view, "0.159.3")).toBe(Date.parse("2026-09-30T23:02:02.182Z"));
    expect(publishedAtOf(view, "0.159.4")).toBeUndefined();
    expect(latestOf({ "dist-tags": { latest: "0.161.0-alpha.13" } })).toBeUndefined();
    expect(latestOf("nope")).toBeUndefined();
  });

  it.effect(
    "asks the user's npm rarely, shares a read, keeps the last good release and falls back to first sight",
    () =>
      Effect.gen(function* () {
        let now = NOW;
        const asked: string[] = [];
        let codexLatest = "0.159.3";
        let failClaude = false;
        let signIn = false;
        const reader = yield* makeVendorReleases({
          now: () => now,
          npmView: (pkg) =>
            Effect.suspend((): Effect.Effect<unknown, NpmViewError> => {
              asked.push(pkg);
              if (signIn && pkg === "@anthropic-ai/claude-code")
                return Effect.fail(new NpmViewError({ problem: "sign-in", message: "refused" }));
              if (pkg.includes("claude-code"))
                return failClaude
                  ? Effect.fail(new NpmViewError({ problem: "unreachable", message: "offline" }))
                  : Effect.succeed(VIEW("2.1.290", { "2.1.290": "2026-09-29T00:00:00Z" }));
              if (pkg.includes("codex"))
                return Effect.succeed(VIEW(codexLatest, { "0.159.3": "2026-09-30T23:00:00Z" }));
              return Effect.succeed(VIEW("1.18.34", {}));
            }),
        });
        const [a, b] = yield* Effect.all([reader.get(false), reader.get(false)], {
          concurrency: "unbounded",
        });
        expect(a).toBe(b);
        expect(asked).toEqual(["@anthropic-ai/claude-code", "@openai/codex"]);
        expect(a.releases.codex).toEqual({
          version: "0.159.3",
          publishedAt: Date.parse("2026-09-30T23:00:00Z"),
        });
        // No publication time in the answer: the wait runs from when it was first seen.
        expect(a.releases.claude).toEqual({
          version: "2.1.290",
          publishedAt: Date.parse("2026-09-29T00:00:00Z"),
        });
        expect(a.checkedAt).toBe(NOW);
        expect(a).not.toHaveProperty("unavailable");

        // A re-check soon after is answered from the cache; ten minutes on, npm is asked again.
        now += 5 * 60_000;
        yield* reader.get(true);
        expect(asked).toHaveLength(2);
        now += 6 * 60_000;
        codexLatest = "0.159.4";
        failClaude = true;
        const c = yield* reader.get(true);
        expect(c.releases.codex).toMatchObject({ version: "0.159.4", publishedAt: now });
        expect(c.releases.claude?.version).toBe("2.1.290");
        // One agent failing isn't "can't check"; a refused sign-in is, whatever else was read.
        expect(c).not.toHaveProperty("unavailable");
        signIn = true;
        now += 11 * 60_000;
        expect((yield* reader.get(true)).unavailable?.problem).toBe("sign-in");
      }),
  );

  // A real clock: the wait is a timeout.
  it.live(
    "answers a listing with what it has while a slow read carries on, then with its result",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const reader = yield* makeVendorReleases({
          now: () => NOW,
          npmView: (pkg) =>
            Deferred.await(gate).pipe(
              Effect.as(VIEW(pkg.includes("codex") ? "0.159.3" : "1.0.0", {})),
            ),
        });
        const early = yield* reader.get(false, 10);
        expect(early).toEqual({ releases: {}, checking: true });
        expect((yield* resolveAgentRuntimes(input({ releases: early }))).releasesChecking).toBe(
          true,
        );
        // The read outlived that wait and keeps going; the next caller gets its answer.
        yield* Deferred.succeed(gate, undefined);
        const later = yield* reader.get(false, 1_000);
        expect(later.releases.codex?.version).toBe("0.159.3");
        expect(later).not.toHaveProperty("checking");
        expect(yield* reader.get(false, 10)).toBe(later);
      }),
  );

  it.effect("says it can't check when npm isn't there, and asks no other registry", () =>
    Effect.gen(function* () {
      const reader = yield* makeVendorReleases({
        now: () => NOW,
        npmView: () =>
          Effect.fail(new NpmViewError({ problem: "npm-missing", message: "npm isn't installed" })),
      });
      const releases = yield* reader.get(false);
      expect(releases).toEqual({
        releases: {},
        unavailable: { problem: "npm-missing", message: "npm isn't installed" },
      });
      const listing = yield* resolveAgentRuntimes(input({ releases }));
      expect(listing.releasesUnavailable?.problem).toBe("npm-missing");
      expect(listing).not.toHaveProperty("releasesCheckedAt");
    }),
  );

  it.effect(
    "runs the user's npm from home, bounded for a cold packument, and hides npm's own errors",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ bin: string; args: ReadonlyArray<string>; options: RunOptions }> = [];
        let answer: ProcOutput | ProcError = {
          status: 0,
          stdout: JSON.stringify(VIEW("0.159.3", {})),
          stderr: "",
          truncated: false,
        };
        const proc = {
          run: (bin: string, args: ReadonlyArray<string>, options: RunOptions) => {
            calls.push({ bin, args, options });
            return "_tag" in answer ? Effect.fail(answer) : Effect.succeed(answer);
          },
        };
        const view = npmView(proc, "/Users/me");
        expect(latestOf(yield* view("@openai/codex"))).toBe("0.159.3");
        expect(calls[0]).toEqual({
          bin: "npm",
          args: ["view", "@openai/codex", "dist-tags", "time", "--json"],
          options: { cwd: "/Users/me", timeoutMs: NPM_VIEW_MS },
        });
        answer = {
          status: 1,
          stdout: "",
          stderr: "npm error 404 https://registry.example/secret-path",
          truncated: false,
        };
        const failed = yield* view("@openai/codex").pipe(Effect.flip);
        expect(failed.message).toBe(REGISTRY_UNREADABLE);
        expect(failed.problem).toBe("unreachable");
        // Only a 401 or 403 is the sign-in; a 407 proxy or a 429 is the network.
        for (const [stderr, problem] of [
          ["npm error code E401\nnpm error Unable to authenticate", "sign-in"],
          ["npm error code E403\nnpm error 403 Forbidden - GET https://x/y", "sign-in"],
          ["npm error code E407\nnpm error 407 Proxy Authentication Required", "unreachable"],
          ["npm error code E429", "unreachable"],
          ["npm error code E404\nnpm error 404 Not Found - GET https://x/y", "unreachable"],
        ] as const) {
          answer = { status: 1, stdout: "", stderr, truncated: false };
          const error = yield* view("@openai/codex").pipe(Effect.flip);
          expect(error.problem, stderr).toBe(problem);
          expect(error.message, stderr).toBe(
            problem === "sign-in" ? REGISTRY_SIGN_IN_EXPIRED : REGISTRY_UNREADABLE,
          );
        }
        answer = new ProcSpawnError({ bin: "npm", message: "ENOENT" });
        expect(yield* view("@openai/codex").pipe(Effect.flip)).toMatchObject({
          problem: "npm-missing",
          message: "npm isn't installed",
        });
      }),
  );
});

describe("resolveAgentRuntimes", () => {
  it.effect("reports source, version and baseline, and steps only where something is to do", () =>
    Effect.gen(function* () {
      const all = yield* run({
        checks: checks(input().checks.tools.filter((tool) => tool.tool !== "claude")),
      });
      expect(all["codex"]).toMatchObject({
        resolved: { source: "path", path: "/opt/homebrew/bin/codex", version: CODEX },
        baseline: BASELINES.codex,
        verdict: "supported",
        installSteps: [],
      });
      expect(all["codex"]).not.toHaveProperty("reason");
      expect(all["codex"]).not.toHaveProperty("managed");
      expect(all["claude"]).toMatchObject({
        verdict: "unknown",
        reason: "Not installed.",
        installSteps: [
          { command: `curl -fsSL https://claude.ai/install.sh | bash -s ${NATIVE}`, exact: true },
          { command: `npm i -g @anthropic-ai/claude-code@${NATIVE}`, exact: true },
        ],
      });
      expect(all["claude"]).not.toHaveProperty("resolved");
    }),
  );

  it.effect("offers no steps where the hosted runtime pins the CLIs, and still judges them", () =>
    Effect.gen(function* () {
      const all = yield* run({ pinnedCli: true });
      expect(all["claude"]).toMatchObject({ verdict: "supported", installSteps: [] });
      expect(all["codex"]).toMatchObject({ verdict: "supported", installSteps: [] });
      expect(all["codex"]).not.toHaveProperty("managed");
    }),
  );

  it.effect("holds a newer release back for 24 hours, and points the steps at it once past", () =>
    Effect.gen(function* () {
      const fresh = yield* run({ releases: released("codex", patch(CODEX, 2), 23) });
      expect(fresh["codex"]!.newer).toMatchObject({
        version: patch(CODEX, 2),
        eligible: false,
        eligibleAt: NOW - 23 * HOUR + RELEASE_AGE_MS,
        verdict: "supported",
      });
      expect(fresh["codex"]!.installSteps).toEqual([]);

      const aged = yield* run({ releases: released("codex", patch(CODEX, 2), 25) });
      expect(aged["codex"]!.newer?.eligible).toBe(true);
      expect(aged["codex"]!.installSteps[0]!.command).toBe(
        `npm i -g @openai/codex@${patch(CODEX, 2)}`,
      );

      // A newer line is news, but nothing to install until it's qualified.
      const line = yield* run({ releases: released("codex", minor(CODEX, 1), 48) });
      expect(line["codex"]!.newer).toMatchObject({ eligible: true, verdict: "unknown" });
      expect(line["codex"]!.installSteps).toEqual([]);

      // Nothing older than or equal to what's installed counts as newer.
      const same = yield* run({ releases: released("codex", CODEX, 48) });
      expect(same["codex"]).not.toHaveProperty("newer");
    }),
  );

  it.effect("steers an old install to the baseline with its own installer", () =>
    Effect.gen(function* () {
      const old = patch(CODEX, -1);
      const all = yield* run({
        checks: checks([
          { tool: "codex", found: true, path: "/opt/homebrew/bin/codex", version: old },
        ]),
        realpath: () => `/opt/homebrew/Cellar/codex/${old}/bin/codex`,
      });
      expect(all["codex"]).toMatchObject({
        verdict: "graceful",
        reason: expect.stringContaining("older than"),
        // With no newer release checked, Homebrew's "latest" isn't offered; the pinned npm is.
        installSteps: [{ installer: "npm", command: `npm i -g @openai/codex@${CODEX}` }],
      });
    }),
  );

  it.effect("offers a 'latest' command only when the latest is past its wait and supported", () =>
    Effect.gen(function* () {
      const old = patch(CODEX, -1);
      const brewed = {
        checks: checks([
          { tool: "codex", found: true, path: "/opt/homebrew/bin/codex", version: old },
        ]),
        realpath: () => `/opt/homebrew/Cellar/codex/${old}/bin/codex`,
      };
      const waiting = yield* run({ ...brewed, releases: released("codex", patch(CODEX, 3), 2) });
      expect(waiting["codex"]!.installSteps.map((step) => step.command)).toEqual([
        `npm i -g @openai/codex@${CODEX}`,
      ]);
      const ready = yield* run({ ...brewed, releases: released("codex", patch(CODEX, 3), 30) });
      expect(ready["codex"]!.installSteps.map((step) => step.command)).toEqual([
        "brew upgrade codex",
        `npm i -g @openai/codex@${patch(CODEX, 3)}`,
      ]);

      // A native Claude Code behind the latest gets the installer pinned to the target instead.
      const claude = yield* run({
        checks: checks([
          {
            tool: "claude",
            found: true,
            path: "/Users/me/.local/bin/claude",
            version: patch(CLAUDE, -1),
          },
        ]),
        releases: released("claude", patch(CLAUDE, 20), 48),
      });
      expect(claude["claude"]!.installSteps[0]).toMatchObject({
        installer: "native",
        command: `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE}`,
        exact: true,
      });
    }),
  );

  it.effect(
    "takes the managed store's runtime when chosen, and offers its next allowed version",
    () =>
      Effect.gen(function* () {
        const active: ManagedInstall = {
          version: CODEX,
          sha256: "0".repeat(64),
          path: "/store/codex/bin/codex",
          installedAt: 1,
        };
        let source: "managed" | "path" = "managed";
        const managed = {
          serves: (agent: RuntimeAgent) => agent === "codex",
          active: () => Effect.succeed(active),
          source: () => Effect.succeed(source),
          allowed: () =>
            Effect.succeed([
              { version: patch(CODEX, 1), channel: "stable" as const },
              { version: CODEX, channel: "stable" as const },
            ]),
        };
        const chosen = yield* run({ managed, releases: released("codex", patch(CODEX, 1), 30) });
        expect(chosen["codex"]).toMatchObject({
          resolved: { source: "managed", path: active.path, version: CODEX },
          managed: { candidate: { version: patch(CODEX, 1), channel: "stable" } },
          installSteps: [],
        });
        expect(chosen["claude"]).not.toHaveProperty("managed");

        source = "path";
        const own = yield* run({ managed });
        expect(own["codex"]!.resolved?.source).toBe("path");
        expect(own["codex"]!.managed?.candidate?.version).toBe(patch(CODEX, 1));

        // Installed but not chosen: the user's own still runs, and Update isn't offered again.
        const installed = {
          ...managed,
          active: () => Effect.succeed({ ...active, version: patch(CODEX, 1) }),
        };
        const after = yield* run({ managed: installed });
        expect(after["codex"]!.resolved?.source).toBe("path");
        expect(after["codex"]!.managed).toEqual({});

        // Pinned by a hosted runtime, the store offers nothing either.
        const pinned = yield* run({ managed, pinnedCli: true });
        expect(pinned["codex"]).not.toHaveProperty("managed");
      }),
  );

  it.effect("doesn't offer the store's version the user's own CLI already runs", () =>
    Effect.gen(function* () {
      // An empty store and a PATH Codex at the baseline: the baseline is what's installed, not news.
      const managed = {
        serves: (agent: RuntimeAgent) => agent === "codex",
        active: () => Effect.succeed(undefined),
        source: () => Effect.succeed("path" as const),
        allowed: () => Effect.succeed([{ version: CODEX, channel: "stable" as const }]),
      };
      const same = yield* run({ managed });
      expect(same["codex"]!.resolved).toMatchObject({ source: "path", version: CODEX });
      expect(same["codex"]!.managed).toEqual({});

      // Newer than the PATH Codex is still offered.
      const newer = yield* run({
        managed: {
          ...managed,
          allowed: () =>
            Effect.succeed([
              { version: patch(CODEX, 1), channel: "stable" as const },
              { version: CODEX, channel: "stable" as const },
            ]),
        },
      });
      expect(newer["codex"]!.managed?.candidate?.version).toBe(patch(CODEX, 1));
    }),
  );
});

describe("the shipped bindings", () => {
  it("takes each baseline from the adapter it ships with", () => {
    expect(BASELINES.codex).toEqual({
      cliVersion: CODEX_CLI_VERSION,
      binding: "codex-protocol",
      bindingVersion: CODEX_CLI_VERSION,
    });
    // Claude Agent SDK 0.3.N pairs with Claude Code 2.1.N.
    expect(BASELINES.claude).toEqual({
      cliVersion: `2.1.${CLAUDE_AGENT_SDK_VERSION.split(".")[2]}`,
      binding: "claude-agent-sdk",
      bindingVersion: CLAUDE_AGENT_SDK_VERSION,
    });
  });
});

describe("npm's refusals", () => {
  it("tells a refused sign-in and an age refusal from everything else", () => {
    expect(refusedSignIn("npm error code E401")).toBe(true);
    expect(refusedSignIn("npm error code E407")).toBe(false);
    expect(
      refusedForAge(
        "npm error code ETARGET\nnpm error notarget No matching version found for @openai/codex@0.160.0 with a date before 2026-09-30",
      ),
    ).toBe(true);
    expect(refusedForAge("npm error code E404")).toBe(false);
  });
});
