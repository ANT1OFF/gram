// One real Gram server for a spec file: the bundled server with the echo fake agent, over a
// temp home, data dir, git repo (origin rewritten to a local bare repo) and a fake `gh`. Nothing
// reads the user's `~/.claude`, git config or GitHub.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, Page } from "@playwright/test";

const webDir = fileURLToPath(new URL("..", import.meta.url));
/** Explicit isolated build inputs keep an already-running example on its sealed old outputs. */
export const SERVER_BUNDLE =
  process.env["GRAM_REAL_E2E_SERVER_BUNDLE"] ?? join(webDir, "../desktop/out/server/server.js");
export const WEB_DIST = process.env["GRAM_REAL_E2E_WEB_DIST"] ?? join(webDir, "dist");
const FAKE_GH = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));
const FAKE_READINESS_CLI = fileURLToPath(new URL("./fake-readiness-cli.cjs", import.meta.url));

export const REPO_SLUG = "acme/web";

interface FakePr {
  number: number;
  branch: string;
  headRefOid: string;
  title: string;
  body: string;
  base: string;
  draft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  checks: "pending" | "failing" | "passing";
  /** GitHub's `mergeStateStatus`; `CLEAN` when absent. */
  mergeState?: string;
  updatedAt: string;
  /** Review summaries in GraphQL's shape (`author.login`, `state`, `commit.oid`, …). */
  reviews?: FakeReview[];
  threads?: FakeReviewThread[];
  issueComments?: Array<{ id: string; author: { login: string }; body: string; createdAt: string }>;
  /** Run ids `gh run rerun` was asked to rerun, in order. */
  reruns?: string[];
  /** How `gh pr merge` merged it. */
  mergeMethod?: "squash" | "merge" | "rebase";
  /** `gh pr merge --auto` turned auto-merge on instead of merging. */
  autoMerge?: boolean;
}

interface FakeReview {
  id: string;
  author: { login: string };
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  submittedAt: string;
  commit: { oid: string };
  body: string;
}

export interface FakeReviewComment {
  id: string;
  author: { login: string; __typename: "Bot" | "User" };
  body: string;
  createdAt: string;
  url: string;
}

interface FakeReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: FakeReviewComment[];
}

interface GhState {
  repo: string;
  /** The bare repository `gh repo clone` clones `repo` from. */
  origin: string;
  nextNumber: number;
  prs: FakePr[];
}

export interface Harness {
  readonly root: string;
  /** The main checkout of the temp repo. */
  readonly repo: string;
  readonly origin: string;
  /** e.g. `http://127.0.0.1:51234`; changes on restart. */
  origin_url(): string;
  /** Sets the launch cookie and opens `path`, without the token ever appearing in a URL. */
  open(page: Page, path?: string): Promise<void>;
  git(cwd: string, ...args: string[]): string;
  /** The fake GitHub's pull requests. */
  prs(): FakePr[];
  setChecks(number: number, checks: FakePr["checks"]): void;
  /** Edits PR `number` in the fake GitHub: reviews, threads, checks, merge state. */
  updatePr(number: number, update: (pr: FakePr) => void): void;
  /** The worktree checked out on a branch ending in `name`, from `git worktree list`. */
  worktreeOnBranch(name: string): string;
  restart(afterExit?: () => void): Promise<void>;
  stop(): Promise<void>;
  /** The server process's pid, for the perf specs' CPU and memory samples. */
  pid(): number | undefined;
}

const run = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** Starts the server and resolves with its port and token once it prints the boot line. */
const startServer = (env: NodeJS.ProcessEnv, logFile: string) =>
  new Promise<{ child: ChildProcess; port: number; token: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_BUNDLE], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server didn't boot in 30 s; log: ${logFile}`));
    }, 30_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      writeFileSync(logFile, output.replaceAll(/boot=[\w-]+/g, "boot=<redacted>"));
      const match = /boot http:\/\/127\.0\.0\.1:(\d+)\/\?boot=([\w-]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve({ child, port: Number(match[1]), token: match[2]! });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}) before booting; log: ${logFile}`));
    });
  });

const stopServer = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });

export interface HarnessOptions {
  /** Explicit synthetic subscription state; never consult the host's CLI accounts. */
  readonly agentAuth?: "signed-in" | "signed-out";
  /** Appends each `git` and `gh` command line the server runs here, as `git …` or `gh …`. */
  readonly commandLog?: string | undefined;
  /** Overrides the server's environment, e.g. a slower git sweep. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "gram-real-e2e-"));
  if (process.env["GRAM_REAL_E2E_KEEP"] === "1") console.log(`real e2e harness root: ${root}`);
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [home, bin, join(root, "data")]) mkdirSync(dir, { recursive: true });

  const gitconfig = join(root, "gitconfig");
  writeFileSync(
    gitconfig,
    "[user]\n\tname = e2e\n\temail = e2e@organization.example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
  );
  const ghState = join(root, "gh-state.json");
  const origin = join(root, "origin.git");
  writeFileSync(
    ghState,
    JSON.stringify({ repo: REPO_SLUG, origin, nextNumber: 1, prs: [] } satisfies GhState),
  );
  const gh = join(bin, "gh");
  const log = (name: string) =>
    options.commandLog === undefined ? "" : `echo "${name} $*" >> "${options.commandLog}"\n`;
  writeFileSync(gh, `#!/bin/sh\n${log("gh")}exec "${process.execPath}" "${FAKE_GH}" "$@"\n`);
  chmodSync(gh, 0o755);
  for (const agent of ["claude", "codex"]) {
    const executable = join(bin, agent);
    writeFileSync(executable, `#!${process.execPath}\n${readFileSync(FAKE_READINESS_CLI, "utf8")}`);
    chmodSync(executable, 0o755);
  }
  if (options.commandLog !== undefined) {
    // A `git` ahead of the real one on the server's PATH, only to log what it runs.
    const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const git = join(bin, "git");
    writeFileSync(git, `#!/bin/sh\n${log("git")}exec "${real}" "$@"\n`);
    chmodSync(git, 0o755);
  }
  // The server probes PATH with `$SHELL -ilc …`; a login shell's path_helper would put a system
  // `gh` ahead of the fake one, so the probe runs the command under this PATH instead. Started any
  // other way it is the Terminal tab's shell, and has to be one: zsh without rc files, or bash
  // without them where there is no zsh (CI's Linux image). It starts a second late so the tab
  // always attaches to a terminal that has printed nothing yet and replays "", which the emulator
  // used to throw on, leaving the terminal dead.
  const shell = join(bin, "probe-shell");
  writeFileSync(
    shell,
    `#!/bin/sh\nif [ "$1" = "-ilc" ]; then exec /bin/sh -c "$2"; fi\nsleep 1\n` +
      `if [ -x /bin/zsh ]; then exec /bin/zsh -f "$@"; fi\nexec /bin/bash --norc --noprofile "$@"\n`,
  );
  chmodSync(shell, 0o755);

  const env: NodeJS.ProcessEnv = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      delimiter,
    ),
    SHELL: shell,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmpdir(),
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    GRAM_REAL_E2E_AGENT_AUTH: options.agentAuth ?? "signed-in",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    FAKE_GH_STATE: ghState,
    GRAM_FAKE_AGENT: "1",
    GRAM_FAKE_AGENT_REPLY: "echo",
    GRAM_DATA_DIR: join(root, "data"),
    GRAM_PORT: "0",
    GRAM_WEB_ROOT: WEB_DIST,
    GRAM_NO_OPEN: "1",
    GRAM_UPDATE_CHECK: "0",
    GRAM_GIT_SWEEP_MS: "1500",
    GRAM_GIT_SETTLE_MS: "500",
    GRAM_BABYSIT_QUIET_MS: "1000",
    GRAM_REVIEW_DEBOUNCE_MS: "400",
    ...options.env,
  };

  // `git@github.com:acme/web.git` names the repo for PR lookups; pushes land in the local bare repo.
  const repo = join(root, "web");
  run(root, env, "init", "-q", "--bare", origin);
  run(root, env, "init", "-q", repo);
  writeFileSync(join(repo, "README.md"), "# web\n");
  mkdirSync(join(repo, "notes"));
  writeFileSync(join(repo, "notes", "seeded.md"), "The needle-7431 lives here.\n");
  run(repo, env, "add", "-A");
  run(repo, env, "commit", "-qm", "initial");
  run(repo, env, "remote", "add", "origin", `git@github.com:${REPO_SLUG}.git`);
  run(repo, env, "config", `url.${origin}.insteadOf`, `git@github.com:${REPO_SLUG}.git`);
  run(repo, env, "push", "-q", "-u", "origin", "main");
  run(repo, env, "remote", "set-head", "origin", "main");

  /** Applies `update` to PR `number` in the fake GitHub, stamping `updatedAt` so badges refetch. */
  const updatePr = (number: number, update: (pr: FakePr) => void) => {
    const state = JSON.parse(readFileSync(ghState, "utf8")) as GhState;
    const pr = state.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`fake gh has no PR #${number}`);
    update(pr);
    pr.updatedAt = new Date().toISOString();
    writeFileSync(ghState, JSON.stringify(state, null, 2));
  };

  const logFile = join(root, "server.log");
  let server = await startServer(env, logFile);

  const originUrl = () => `http://127.0.0.1:${server.port}`;
  const boot = async (context: BrowserContext) => {
    await context.clearCookies();
    await context.addCookies([
      {
        name: `sb_token_${server.port}`,
        value: server.token,
        url: originUrl(),
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
  };

  return {
    root,
    repo,
    origin,
    origin_url: originUrl,
    open: async (page, path = "/") => {
      await boot(page.context());
      await page.goto(`${originUrl()}${path}`);
    },
    git: (cwd, ...args) => run(cwd, env, ...args),
    prs: () => (JSON.parse(readFileSync(ghState, "utf8")) as GhState).prs,
    setChecks: (number, checks) => updatePr(number, (pr) => void (pr.checks = checks)),
    updatePr: (number, update) => updatePr(number, update),
    worktreeOnBranch: (name) => {
      let path: string | undefined;
      for (const line of run(repo, env, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        if (line.startsWith("branch refs/heads/") && line.endsWith(name) && path) return path;
      }
      throw new Error(`no worktree on a branch named like ${name}`);
    },
    restart: async (afterExit) => {
      await stopServer(server.child);
      afterExit?.();
      server = await startServer(env, logFile);
    },
    pid: () => server.child.pid,
    stop: async () => {
      await stopServer(server.child);
      if (process.env["GRAM_REAL_E2E_KEEP"] !== "1") rmSync(root, { recursive: true, force: true });
    },
  };
}
