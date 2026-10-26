import { readdirSync } from "node:fs";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { describe, expect, it } from "vitest";
import { FS_RESOLVE_LIMIT, FsResolveFields, FsResolveResult } from "./fs-files.ts";
import { BranchList, Diff, GitState, PrChecksResult, PrDetailResult } from "./git.ts";
import { ComposedIssue, FiledIssue, IssueDraft, newIssueUrl } from "./issues.ts";
import {
  AgentUnavailable,
  AppToolError,
  GitError,
  InterruptHung,
  InvalidState,
  NotFound,
  NotImplemented,
  ThreadNotFound,
} from "./errors.ts";
import { ServerEvent, ThreadFeedEvent } from "./events.ts";
import { TerminalEvent, TerminalInfo } from "./terminal.ts";
import { FolderListing, FsFile, FsListing } from "./fs.ts";
import { ModelList } from "./models.ts";
import { GramRpcGroups, GramRpcs } from "./rpc.ts";
import {
  RestartSessionResult,
  StartSessionResult,
  ThreadHistoryPage,
  ThreadSearchResult,
} from "./threads.ts";
import {
  CloneProjectPayload,
  CloneSuggestions,
  looksLikeFolderPath,
  parseRepoRemote,
  remoteKey,
} from "./projects.ts";
import { recentTurns } from "./feed-window.ts";
import { ThreadPlan } from "./thread-plan.ts";
import { RestoreWorktreeResult } from "./worktrees.ts";
import { expectRoundTrip } from "./test-utils.ts";

const thread = {
  id: "t1",
  projectId: "p1",
  title: "rewrite",
  userNamed: true,
  model: { agent: "claude", model: "opus", variant: "high" },
  mode: "plan",
  checkout: { kind: "main", path: "/repo", branch: "main" },
  labels: [],
  unread: false,
  pinned: true,
  parked: false,
  createdAt: 1,
  lastActivityAt: 2,
};

const threadPlan = {
  goal: "Make the retry test deterministic",
  goalBy: "agent",
  steps: [
    {
      id: "s1",
      text: "Reproduce the flake",
      status: "done",
      source: "helper",
      evidence: "3 of 20 fail",
    },
    {
      id: "s2",
      text: "Push and get #412 green",
      status: "doing",
      source: "user",
      locked: true,
      pr: { number: 412, repo: "acme/api" },
    },
    { id: "s3", text: "Merge #412", status: "todo", source: "agent", pr: { number: 412 } },
  ],
  next: "s2",
  basis: "rev:12",
  updatedAt: 1_758_800_000_000,
  updatedBy: "user",
};

const gitState = {
  repo: true,
  branch: "fix/flaky",
  worktree: true,
  head: "abc123",
  changesToken: "tok",
  changedFiles: 3,
  base: "origin/main",
  behindBase: 2,
  aheadBase: 1,
  conflicts: true,
  upstream: "diverged",
  pr: {
    number: 412,
    state: "OPEN",
    url: "https://github.com/o/r/pull/412",
    title: "Fix flaky test",
    isDraft: false,
    checks: "failing",
    requiredChecks: "pending",
    headMatches: true,
    aheadOfPr: false,
    baseRef: "main",
  },
  origin: "o/r",
};

describe("ServerEvent", () => {
  it("round-trips every variant", () => {
    const events = [
      {
        type: "threads.snapshot",
        threads: [
          {
            thread,
            status: "running",
            pendingRequests: [],
            queue: [{ id: "q1", input: { text: "also update docs" } }],
            identity: { model: "claude-opus-5", commands: [] },
            usage: { tokens: { inputTokens: 1200, outputTokens: 300 }, contextWindow: 200000 },
            git: gitState,
            activity: "Running pnpm test…",
            compaction: { startedAt: 1_758_800_000_000, trigger: "manual", preTokens: 13_952 },
            background: [
              {
                taskId: "b1",
                kind: "shell",
                description: "Run the checks",
                command: "pnpm check",
                toolCallId: "toolu_3",
                startedAt: 1_758_800_000_000,
              },
            ],
            terminalProcesses: [
              { terminalId: "term1", pid: 4120, command: "pnpm dev", startedAt: 1_758_800_000_000 },
            ],
            plan: threadPlan,
            turnPlan: [{ content: "Push the branch", status: "inProgress" }],
          },
        ],
      },
      { type: "thread.upsert", thread },
      { type: "thread.removed", threadId: "t1" },
      { type: "thread.status", threadId: "t1", status: "needsApproval" },
      {
        type: "thread.status",
        threadId: "t1",
        status: "running",
        detail: "Compacting context",
        compaction: { startedAt: 1_758_800_000_000, trigger: "auto" },
      },
      {
        type: "thread.request",
        threadId: "t1",
        request: {
          kind: "question",
          id: "r1",
          questions: [{ question: "Q?", header: "H", options: [], multiSelect: true }],
        },
      },
      { type: "thread.requestResolved", threadId: "t1", requestId: "r1" },
      {
        type: "thread.queue",
        threadId: "t1",
        queue: [
          { id: "q2", input: { text: "then bump the version", attachments: [{ path: "/a.png" }] } },
        ],
      },
      {
        type: "thread.identity",
        threadId: "t1",
        identity: {
          model: "claude-opus-5",
          commands: [{ name: "compact", description: "Compact the conversation" }],
        },
      },
      {
        type: "thread.usage",
        threadId: "t1",
        usage: {
          tokens: { inputTokens: 5000, outputTokens: 800, cacheReadTokens: 40000 },
          contextWindow: 200000,
          costUsd: 0.42,
          costEstimated: true,
        },
      },
      {
        type: "thread.plan",
        threadId: "t1",
        items: [
          { content: "Reproduce the flake", status: "completed" },
          { content: "Fix the retry", status: "inProgress", activeForm: "Fixing the retry" },
        ],
        plan: threadPlan,
      },
      { type: "git.state", threadId: "t1", state: gitState },
      {
        type: "pr.reviewRound",
        threadId: "t1",
        round: {
          number: 12,
          reviewId: "PRR_2",
          verdict: "changesRequested",
          verdictOnHead: "changesRequested",
          counts: { unresolved: 2, blockers: 1, suggestions: 1, outdatedUnresolved: 0 },
        },
      },
      { type: "thread.ports", threadId: "t1", ports: [3000, 5173] },
      {
        type: "thread.background",
        threadId: "t1",
        tasks: [
          { taskId: "a1", kind: "subagent", description: "Explore", startedAt: 1_758_800_000_000 },
        ],
      },
      { type: "thread.background", threadId: "t1", tasks: [] },
      { type: "thread.backgroundOutput", threadId: "t1", taskId: "b1", output: "ready\n" },
      { type: "thread.pendingRestart", threadId: "t1", reason: "mcpConfig" },
      { type: "thread.pendingRestart", threadId: "t1" },
      { type: "thread.lapsedConnectors", threadId: "t1", names: ["claude.ai Atlassian"] },
      { type: "thread.terminalProcesses", threadId: "t1", processes: [] },
      { type: "notify", kind: "done", title: "rewrite finished", threadId: "t1" },
      {
        type: "rateLimit",
        threadId: "t1",
        status: "warning",
        window: "overage",
        utilization: 0.94,
        resetsAt: 1_790_000_000_000,
      },
      {
        type: "usageLimit",
        threadId: "t1",
        agent: "codex",
        status: "allowed",
        window: "five_hour",
        utilization: 0.42,
        resetsAt: 1_790_000_000_000,
      },
      {
        type: "usageLimit",
        threadId: "t1",
        agent: "claude",
        gateway: true,
        profileId: "openrouter",
        status: "rejected",
        window: "seven_day",
      },
      {
        type: "usageLimits.snapshot",
        limits: [
          {
            agent: "claude",
            window: "five_hour",
            status: "allowed",
            utilization: 0.42,
            resetsAt: 1_790_000_000_000,
            at: 1_789_990_000_000,
            samples: [
              { at: 1_789_980_000_000, utilization: 0.3 },
              { at: 1_789_990_000_000, utilization: 0.42 },
            ],
          },
          {
            agent: "codex",
            profileId: "openrouter",
            window: "seven_day",
            status: "rejected",
            utilization: 1,
            at: 1_789_990_000_000,
            samples: [{ at: 1_789_990_000_000, utilization: 1 }],
          },
        ],
      },
      { type: "ui.showPanel", threadId: "t1", panel: "diff", target: "src/a.ts" },
      {
        type: "ui.showPanel",
        threadId: "t1",
        panel: "preview",
        target: "https://organization.example.invalid/",
        driven: true,
      },
      {
        type: "keybindings.changed",
        keybindings: {
          path: "/data/keybindings.json",
          bindings: { "thread.new": "mod+shift+n", "panel.toggle": null },
          problems: [],
        },
      },
      {
        type: "thread.waits",
        threadId: "t1",
        waits: [
          { id: "w-1", kind: "draft", title: "Teams message", source: "agent", createdAt: 1 },
        ],
      },
      { type: "settings.changed" },
      { type: "profiles.changed" },
      { type: "reviewRequests.changed" },
      { type: "openPrs.changed" },
      { type: "threadWakes.changed" },
      { type: "workspaces.changed" },
      { type: "orchestration.changed", workspaceId: "w1" },
      { type: "memory.changed", workspaceId: "w1" },
      { type: "dreams.changed", workspaceId: "w1" },
      { type: "outputs.changed", workspaceId: "w1" },
      { type: "thread.suggestions", threadId: "t1", turnId: "turn-1", replies: ["Push it"] },
      { type: "thread.suggestions", threadId: "t1", turnId: "turn-1", replies: [], stale: true },
    ];
    expect(new Set(events.map((e) => e.type)).size).toBe(ServerEvent.members.length);
    for (const event of events)
      expectRoundTrip(ServerEvent, Schema.decodeUnknownSync(ServerEvent)(event));
  });

  it("GitState keeps absent optional fields absent", () => {
    const minimal = {
      repo: false,
      worktree: false,
      head: "",
      changesToken: "",
      changedFiles: 0,
      behindBase: 0,
      aheadBase: 0,
      conflicts: false,
    };
    expect(Schema.encodeSync(GitState)(Schema.decodeUnknownSync(GitState)(minimal))).toEqual(
      minimal,
    );
    const missing = { ...minimal, missingPrs: [{ repo: "acme/lib", number: 42 }] };
    expectRoundTrip(GitState, Schema.decodeUnknownSync(GitState)(missing));
    expectRoundTrip(GitState, Schema.decodeUnknownSync(GitState)({ ...minimal, missing: true }));
    const pr = {
      number: 459,
      state: "OPEN",
      url: "https://github.com/acme/lib/pull/459",
      title: "Retry",
      isDraft: false,
      checks: "failing",
      failingChecks: { names: ["e2e (linux, light-2)"], readAt: 1 },
      headMatches: true,
      aheadOfPr: false,
    };
    expectRoundTrip(GitState, Schema.decodeUnknownSync(GitState)({ ...minimal, pr }));
  });

  it("RestoreWorktreeResult round-trips each outcome", () => {
    for (const result of [
      { _tag: "restored", path: "/r/.worktrees/x", branch: "feat/x", source: "origin" },
      { _tag: "branchGone", branch: "feat/x", pr: { repo: "acme/web", number: 7 } },
      { _tag: "branchGone", branch: "feat/x" },
    ]) {
      expectRoundTrip(
        RestoreWorktreeResult,
        Schema.decodeUnknownSync(RestoreWorktreeResult)(result),
      );
    }
  });
});

const m = (id: string, role: "user" | "assistant") => ({ id, role });

describe("ThreadFeedEvent", () => {
  it("round-trips every variant", () => {
    const events = [
      {
        type: "messages",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      },
      {
        type: "messages",
        messages: [{ id: "m0", role: "user", parts: [{ type: "text", text: "later" }] }],
        earlier: true,
      },
      {
        type: "resumed",
        messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "done" }] }],
      },
      { type: "chunk", messageId: "m2", chunk: { type: "text-start", id: "t" } },
      { type: "caughtUp", rev: 0 },
      {
        type: "message",
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
        rev: 42,
      },
    ];
    expect(new Set(events.map((e) => e.type)).size).toBe(ThreadFeedEvent.members.length);
    for (const event of events)
      expectRoundTrip(ThreadFeedEvent, Schema.decodeUnknownSync(ThreadFeedEvent)(event));
  });

  it("windows the recent turns the way the server's SQL does", () => {
    const all = [m("a0", "assistant"), m("u1", "user"), m("a1", "assistant"), m("u2", "user")];
    expect(recentTurns(all, 1)).toEqual({ messages: [m("u2", "user")], earlier: true });
    expect(recentTurns(all, 2)).toEqual({ messages: all.slice(1), earlier: true });
    expect(recentTurns(all, 3)).toEqual({ messages: all, earlier: false });
    expect(recentTurns(all, 1, "u2")).toEqual({ messages: all.slice(1, 3), earlier: true });
    expect(recentTurns(all, 1, "u1")).toEqual({ messages: [all[0]], earlier: false });
    expect(recentTurns(all, 1, "gone")).toEqual({ messages: [], earlier: false });
  });

  it("rejects a revision that isn't a non-negative integer", () => {
    for (const rev of [-1, 1.5, "3"]) {
      expect(() => Schema.decodeUnknownSync(ThreadFeedEvent)({ type: "caughtUp", rev })).toThrow();
    }
  });

  it("rejects a message without parts", () => {
    expect(() =>
      Schema.decodeUnknownSync(ThreadFeedEvent)({
        type: "messages",
        messages: [{ id: "m1", role: "user" }],
      }),
    ).toThrow();
  });
});

describe("git shapes", () => {
  const file = {
    path: "src/a.ts",
    status: "untracked",
    additions: 3,
    deletions: 0,
    patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
    binary: false,
    tooLarge: false,
  };

  it("Diff and BranchList round-trip", () => {
    for (const diff of [
      { repo: true, branch: "fix/flaky", worktree: "/repo", files: [file] },
      { repo: true, base: "origin/main", note: "Diff too large to display", files: [] },
      { repo: false },
    ])
      expectRoundTrip(Diff, Schema.decodeUnknownSync(Diff)(diff));
    expectRoundTrip(
      BranchList,
      Schema.decodeUnknownSync(BranchList)({ branches: ["main", "develop"], default: "main" }),
    );
  });

  it("PrDetailResult round-trips", () => {
    const detail = {
      number: 412,
      state: "OPEN",
      url: "https://github.com/o/r/pull/412",
      title: "Fix flaky test",
      body: "",
      isDraft: false,
      author: "octocat",
      baseRefName: "main",
      headRefName: "fix/flaky",
      additions: 12,
      deletions: 4,
      changedFiles: 1,
      commits: 2,
      reviewDecision: "APPROVED",
      checks: "passing",
      checksPassed: 3,
      checksTotal: 3,
      checkRuns: [{ name: "ci", status: "passing", link: "https://ci.example/1", required: true }],
      commitList: [{ oid: "abc", headline: "fix", author: "octocat", at: "2026-09-16T10:00:00Z" }],
      conversation: [
        {
          kind: "review",
          author: "rev",
          state: "APPROVED",
          body: "lgtm",
          at: "2026-09-16T11:00:00Z",
        },
      ],
      files: [file],
    };
    for (const result of [
      { available: true, detail },
      { available: true, error: "boom" },
      { available: false },
    ])
      expectRoundTrip(PrDetailResult, Schema.decodeUnknownSync(PrDetailResult)(result));
  });

  it("PrChecksResult round-trips", () => {
    const run = {
      name: "test (macos)",
      status: "failing",
      link: "https://github.com/o/r/actions/runs/7/job/2",
      runId: "7",
      conclusion: "FAILURE",
      phase: "completed",
      startedAt: "2026-09-16T10:41:00Z",
      completedAt: "2026-09-16T10:44:00Z",
    };
    for (const result of [
      { checks: [] },
      { checks: [run, { name: "ci/external", status: "pending", link: "" }] },
    ])
      expectRoundTrip(PrChecksResult, Schema.decodeUnknownSync(PrChecksResult)(result));
    expect(() => Schema.decodeUnknownSync(PrChecksResult)({})).toThrow();
  });
});

describe("ModelList", () => {
  it("round-trips and rejects an unknown effort", () => {
    const list = {
      models: [
        {
          id: "opus",
          displayName: "Opus",
          description: "Most capable",
          supportsEffort: true,
          efforts: ["low", "medium", "high", "xhigh", "max"],
          isDefault: true,
          resolvedId: "claude-opus-5-5",
        },
        { id: "haiku", displayName: "Haiku", supportsEffort: false },
        {
          id: "gpt-6.1-sol",
          displayName: "gpt-6.1-sol",
          supportsEffort: true,
          effortsUnlisted: true,
        },
      ],
    };
    expectRoundTrip(ModelList, Schema.decodeUnknownSync(ModelList)(list));
    expect(() =>
      Schema.decodeUnknownSync(ModelList)({
        models: [{ id: "x", displayName: "X", supportsEffort: true, efforts: ["ultra"] }],
      }),
    ).toThrow();
  });
});

describe("FolderListing", () => {
  it("round-trips with and without a parent and a .git", () => {
    for (const listing of [
      {
        path: "/Users/x/Documents/code",
        parent: "/Users/x/Documents",
        git: "unreadable",
        entries: [
          {
            name: "sample_app",
            path: "/Users/x/Documents/code/sample_app",
            isGitRepo: true,
          },
        ],
        truncated: false,
      },
      { path: "/", entries: [], truncated: true },
    ])
      expectRoundTrip(FolderListing, Schema.decodeUnknownSync(FolderListing)(listing));
  });
});

const keyOf = (input: string) => {
  const remote = parseRepoRemote(input);
  return "error" in remote ? remote.error : remoteKey(remote);
};

describe("cloning", () => {
  it("round-trips the payload and the suggestions, and rejects a blank remote", () => {
    expectRoundTrip(CloneProjectPayload, { remote: "EXAMPLE/example-device-apps" });
    expectRoundTrip(CloneProjectPayload, {
      remote: "EXAMPLE/example-device-apps",
      into: "/Users/x/code",
    });
    expectRoundTrip(CloneSuggestions, {
      repos: ["EXAMPLE/example-device-apps", "ANT1OFF/gram"],
    });
    expect(() => Schema.decodeUnknownSync(CloneProjectPayload)({ remote: "" })).toThrow();
  });

  it("reads GitHub's owner/repo in every spelling as one repository", () => {
    const github = { kind: "github", owner: "EXAMPLE", repo: "example-device-apps" };
    for (const input of [
      "EXAMPLE/example-device-apps",
      " EXAMPLE/example-device-apps.git ",
      "EXAMPLE/example-device-apps/",
      "github.com/EXAMPLE/example-device-apps",
      "https://github.com/EXAMPLE/example-device-apps",
      "https://www.github.com/EXAMPLE/example-device-apps.git",
      "https://GitHub.com/EXAMPLE/example-device-apps/",
    ])
      expect(parseRepoRemote(input), input).toEqual(github);
    const keys = [
      "EXAMPLE/example-device-apps",
      "git@github.com:example/example-device-apps.git",
      "ssh://git@github.com/EXAMPLE/example-device-apps",
    ]
      .map((input) => parseRepoRemote(input))
      .map((remote) => ("error" in remote ? remote.error : remoteKey(remote)));
    expect(new Set(keys)).toEqual(new Set(["github.com/example/example-device-apps"]));
  });

  it("keeps other URLs for git, ssh ones for github.com included", () => {
    expect(parseRepoRemote("git@github.com:EXAMPLE/example-device-apps.git")).toEqual({
      kind: "url",
      url: "git@github.com:EXAMPLE/example-device-apps.git",
      host: "github.com",
      path: "EXAMPLE/example-device-apps",
      repo: "example-device-apps",
    });
    expect(parseRepoRemote("https://organization.example.invalid/group/sub/tool.git")).toEqual({
      kind: "url",
      url: "https://organization.example.invalid/group/sub/tool.git",
      host: "organization.example.invalid",
      path: "group/sub/tool",
      repo: "tool",
    });
    expect(parseRepoRemote("ssh://git@organization.example.invalid:2222/team/app")).toMatchObject({
      kind: "url",
      url: "ssh://git@organization.example.invalid:2222/team/app",
      host: "organization.example.invalid:2222",
      repo: "app",
    });
    // Another port can be another server, so it's another repository.
    const [a, b] = [
      "ssh://git@organization.example.invalid:2222/team/app",
      "ssh://git@organization.example.invalid:2223/team/app",
    ]
      .map((input) => parseRepoRemote(input))
      .map((remote) => ("error" in remote ? remote.error : remoteKey(remote)));
    expect(a).not.toBe(b);
    // Nor is a path that differs only in case, except on GitHub, which ignores it.
    expect(keyOf("ssh://git@organization.example.invalid/team/App")).toBe(
      "organization.example.invalid/team/App",
    );
    expect(keyOf("ssh://git@organization.example.invalid/team/app")).not.toBe(
      keyOf("ssh://git@organization.example.invalid/team/App"),
    );
  });

  it("refuses anything that could be an option, a traversal, a credential or a shell word", () => {
    for (const input of [
      "",
      "-uhttps://evil",
      "--upload-pack=touch /tmp/x",
      "EXAMPLE/..",
      "EXAMPLE/.",
      "../example-device-apps",
      "EXAMPLE/sys iru",
      "EXAMPLE/example-device-apps;rm",
      "EXAMPLE/example-device-apps\nfoo",
      "EXAMPLE/a/b",
      "-EXAMPLE/example-device-apps",
      "https://github.com/EXAMPLE/example-device-apps/tree/main",
      "https://github.com/EXAMPLE/../etc",
      "https://x-access-token:ghp_abc@github.com/EXAMPLE/example-device-apps",
      "https://github.com/EXAMPLE/example-device-apps?ref=main",
      "http://github.com/EXAMPLE/example-device-apps",
      "file:///etc/passwd",
      "ext::sh -c touch% /tmp/x",
      "git@github.com:/etc/passwd",
      "EXAMPLE/example-device-apps\u0000",
    ])
      expect(parseRepoRemote(input), input).toHaveProperty("error");
    expect(parseRepoRemote("https://u:p@github.com/EXAMPLE/x")).toEqual({
      error: "Paste the repository's URL without a user name or token in it.",
    });
  });

  it("tells a folder's path from a repository", () => {
    for (const path of ["~/code/api", "/Users/x/api", "./api", "C:\\code\\api", "C:/code/api"])
      expect(looksLikeFolderPath(path), path).toBe(true);
    for (const remote of ["EXAMPLE/api", "https://github.com/EXAMPLE/api", "git@host:a/b"])
      expect(looksLikeFolderPath(remote), remote).toBe(false);
  });
});

describe("terminal, files and search shapes", () => {
  it("round-trips terminal events and info", () => {
    for (const event of [
      { type: "replay", data: "$ ls\r\n" },
      { type: "data", data: "a.txt\r\n" },
      { type: "exit", code: 0 },
      { type: "exit", signal: "SIGHUP" },
    ])
      expectRoundTrip(TerminalEvent, Schema.decodeUnknownSync(TerminalEvent)(event));
    expectRoundTrip(
      TerminalInfo,
      Schema.decodeUnknownSync(TerminalInfo)({
        terminalId: "term-1",
        threadId: "t1",
        cwd: "/repo",
        shell: "/bin/zsh",
        alive: true,
      }),
    );
  });

  it("round-trips file listings and previews", () => {
    expectRoundTrip(
      FsListing,
      Schema.decodeUnknownSync(FsListing)({
        path: "/repo/src",
        parent: "/repo",
        entries: [
          { name: "lib", path: "/repo/src/lib", kind: "dir", modifiedAt: 1726480000000 },
          { name: "a.ts", path: "/repo/src/a.ts", kind: "file", size: 120, modifiedAt: 1 },
          { name: "current", path: "/repo/src/current", kind: "symlink" },
        ],
        truncated: false,
      }),
    );
    for (const file of [
      {
        path: "/repo/src/a.ts",
        size: 120,
        binary: false,
        tooLarge: false,
        content: "export {}\n",
        language: "typescript",
      },
      { path: "/repo/logo.png", size: 4096, binary: true, tooLarge: false },
      { path: "/repo/dump.sql", size: 90000000, binary: false, tooLarge: true },
    ])
      expectRoundTrip(FsFile, Schema.decodeUnknownSync(FsFile)(file));
  });

  it("round-trips resolved file references", () => {
    expectRoundTrip(
      FsResolveResult,
      Schema.decodeUnknownSync(FsResolveResult)({
        files: [{ path: "src/a.ts", resolved: "/repo/src/a.ts" }],
      }),
    );
    expect(() =>
      Schema.decodeUnknownSync(Schema.Struct(FsResolveFields))({
        threadId: "t-1",
        paths: Array.from({ length: FS_RESOLVE_LIMIT + 1 }, (_, i) => `f${i}.ts`),
      }),
    ).toThrow();
  });

  it("round-trips search results with highlights", () => {
    expectRoundTrip(
      ThreadSearchResult,
      Schema.decodeUnknownSync(ThreadSearchResult)({
        hits: [
          {
            threadId: "t1",
            messageId: "m3",
            title: "fix-flaky-test",
            snippet: "the retry test is flaky",
            highlights: [{ start: 4, end: 9 }],
          },
          { threadId: "t2", title: "rewrite", snippet: "retry" },
        ],
        truncated: true,
      }),
    );
  });
});

describe("issue shapes", () => {
  it("round-trips a draft, a composed issue and a filed one, and rejects a blank title", () => {
    expectRoundTrip(IssueDraft, {
      kind: "bug",
      title: "Terminal freezes",
      body: "It froze.",
      area: "web",
      includeDiagnostics: true,
    });
    expectRoundTrip(IssueDraft, {
      kind: "question",
      title: "Why?",
      body: "",
      includeDiagnostics: false,
    });
    expect(() =>
      Schema.decodeUnknownSync(IssueDraft)({
        kind: "bug",
        title: "",
        body: "",
        includeDiagnostics: false,
      }),
    ).toThrow();
    const issue = { repo: "ANT1OFF/gram", labels: ["bug"], title: "t", body: "b" };
    expectRoundTrip(ComposedIssue, { ...issue, newIssueUrl: newIssueUrl(issue) });
    expectRoundTrip(FiledIssue, {
      number: 7,
      url: "https://github.com/ANT1OFF/gram/issues/7",
    });
  });

  it("cuts a long body in the new-issue link", () => {
    const url = newIssueUrl({ repo: "o/r", title: "t", body: "x".repeat(9000), labels: [] });
    const body = new URL(url).searchParams.get("body") ?? "";
    expect(body.length).toBeLessThan(6100);
    expect(body.endsWith("…(cut to fit the link)")).toBe(true);
  });
});

describe("errors", () => {
  it("round-trip as tagged errors", () => {
    const errors = Schema.Union([ThreadNotFound, InvalidState, GitError, NotFound]);
    const decoded = Schema.decodeUnknownSync(errors)({
      _tag: "InvalidState",
      message: "idle",
      status: "idle",
    });
    expect(decoded).toBeInstanceOf(InvalidState);
    expect(Schema.encodeSync(errors)(decoded)).toEqual({
      _tag: "InvalidState",
      message: "idle",
      status: "idle",
    });
    expectRoundTrip(errors, new GitError({ message: "boom", stderr: "fatal" }));
    expectRoundTrip(
      errors,
      new InvalidState({ message: "gone", folderMissing: { path: "/r/.worktrees/x" } }),
    );
    expectRoundTrip(errors, new NotFound({ entity: "queueItem", id: "q1" }));
    expectRoundTrip(errors, new NotFound({ entity: "terminal", id: "term-1" }));
    expectRoundTrip(
      errors,
      new NotFound({ entity: "project", id: "/nope", message: "Folder not found: /nope" }),
    );

    const more = Schema.Union([NotImplemented, InterruptHung, AppToolError, AgentUnavailable]);
    expectRoundTrip(more, new NotImplemented({ rpc: "git.diff" }));
    expectRoundTrip(more, new InterruptHung({ timeoutMs: 5000 }));
    expectRoundTrip(
      more,
      new AppToolError({
        tool: "set_auto_merge",
        message: "needs approval",
        approvalRequired: true,
      }),
    );
    expectRoundTrip(
      more,
      new AgentUnavailable({
        agent: "claude",
        reason: "not-logged-in",
        message: "Run claude /login",
      }),
    );
  });
});

/** Decodes a payload for the RPC with this tag, as the server would on receiving it. */
const payloadOf = (tag: string) =>
  Schema.decodeUnknownSync(
    (GramRpcs.requests as ReadonlyMap<string, { payloadSchema: Schema.Top }>).get(tag)!
      .payloadSchema as Schema.Codec<unknown, unknown>,
  );

describe("GramRpcs", () => {
  it("is its domain groups, no tag in two of them", () => {
    const tags = GramRpcGroups.flatMap((group) => [...group.requests.keys()]);
    expect(new Set(tags).size).toBe(tags.length);
    expect(new Set(tags)).toEqual(new Set(GramRpcs.requests.keys()));
  });

  it("exports from each subpath entry only what the root exports", async () => {
    const root: Record<string, unknown> = await import("./index.ts");
    const entries = readdirSync(new URL("./entries", import.meta.url));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries.map((file) => file.replace(/\.ts$/, ""))) {
      const exports: Record<string, unknown> = await import(`./entries/${entry}.ts`);
      for (const [name, value] of Object.entries(exports)) {
        expect(root[name], `${entry}: ${name}`).toBe(value);
      }
    }
  });

  it("covers the commands and subscriptions", () => {
    const tags = [...GramRpcs.requests.keys()];
    expect(tags).toEqual(
      expect.arrayContaining([
        ...[
          "create",
          "send",
          "steer",
          "interrupt",
          "respond",
          "setMode",
          "setModel",
          "fork",
          "rewind",
          "rename",
          "pin",
          "park",
          "label",
          "close",
          "subscribe",
          "markUnread",
          "markCompleted",
          "search",
        ].map((c) => `thread.${c}`),
        "thread.queue.edit",
        "thread.queue.reorder",
        "thread.queue.remove",
        "thread.queue.steer",
        "thread.setReviewMonitor",
        "task.accept",
        "task.dismiss",
        "pr.bind",
        "pr.unbind",
        "pr.status",
        "pr.setMonitor",
        "pr.bindExtra",
        "pr.unbindExtra",
        "pr.setExtraMonitor",
        "pr.promote",
        "pr.hide",
        "pr.showHidden",
        "pr.requestReview",
        "pr.reviewerSuggestions",
        "pr.labels.list",
        "pr.labels.add",
        "pr.labels.remove",
        "pr.checkout",
        "ui.showPanel",
        "worktree.list",
        "worktree.remove",
        "git.diff",
        "git.prDetail",
        "git.branches",
        "fs.tree",
        "fs.file",
        "fs.browse",
        "fs.list",
        "fs.search",
        "fs.files",
        "fs.resolve",
        "terminal.open",
        "terminal.input",
        "terminal.resize",
        "terminal.close",
        "terminal.list",
        "terminal.subscribe",
        "terminal.checkShell",
        "models.list",
        "models.suggestions",
        "projects.list",
        "settings.get",
        "settings.set",
        "profiles.list",
        "profiles.importKey",
        "palettes.list",
        "app.diagnostics",
        "app.diagnosticsReport",
        "app.openLogsFolder",
        "app.openExternal",
        "app.launchChecks",
        "events.subscribe",
      ]),
    );
  });

  it("lets every RPC fail with NotImplemented", () => {
    for (const [tag, rpc] of GramRpcs.requests) {
      const error = RpcSchema.isStreamSchema(rpc.successSchema)
        ? rpc.successSchema.error
        : rpc.errorSchema;
      const decoded = Schema.decodeUnknownSync(error as Schema.Codec<unknown, unknown>)({
        _tag: "NotImplemented",
        rpc: tag,
      });
      expect(decoded, tag).toBeInstanceOf(NotImplemented);
    }
  });

  it("decodes an fs.browse payload and rejects a non-positive limit", () => {
    const rpc = GramRpcs.requests.get("fs.browse")!;
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
    expect(decode({ path: "~/Documents/code/cl", limit: 50 })).toEqual({
      path: "~/Documents/code/cl",
      limit: 50,
    });
    expect(() => decode({ path: "~/", limit: 0 })).toThrow();
  });

  it("decodes a thread.subscribe payload with and without afterRev", () => {
    const subscribe = payloadOf("thread.subscribe");
    expect(subscribe({ threadId: "t1" })).toEqual({ threadId: "t1" });
    expect(subscribe({ threadId: "t1", afterRev: 7 })).toEqual({ threadId: "t1", afterRev: 7 });
    expect(() => subscribe({ threadId: "t1", afterRev: -1 })).toThrow();
    expect(subscribe({ threadId: "t1", afterRev: 7, from: "m1" })).toMatchObject({ from: "m1" });
    expect(payloadOf("thread.history")({ threadId: "t1", before: "m1" })).toEqual({
      threadId: "t1",
      before: "m1",
    });
    expectRoundTrip(ThreadHistoryPage, { messages: [], earlier: false });
  });

  it("decodes a thread.restartSession payload and round-trips each outcome", () => {
    const restart = payloadOf("thread.restartSession");
    expect(restart({ threadId: "t1" })).toEqual({ threadId: "t1" });
    expect(restart({ threadId: "t1", midTurn: "interrupt" })).toEqual({
      threadId: "t1",
      midTurn: "interrupt",
    });
    expect(() => restart({ threadId: "t1", midTurn: "now" })).toThrow();
    for (const outcome of ["restarting", "afterTurn", "noSession"] as const) {
      expectRoundTrip(RestartSessionResult, outcome);
    }
  });

  it("decodes a thread.startSession payload and round-trips each outcome", () => {
    const start = payloadOf("thread.startSession");
    expect(start({ threadId: "t1" })).toEqual({ threadId: "t1" });
    expect(() => start({})).toThrow();
    for (const outcome of ["starting", "open"] as const) {
      expectRoundTrip(StartSessionResult, outcome);
    }
    expect(() => Schema.decodeUnknownSync(StartSessionResult)("noSession")).toThrow();
  });

  it("decodes fork, terminal and file payloads", () => {
    const fork = Schema.decodeUnknownSync(GramRpcs.requests.get("thread.fork")!.payloadSchema);
    expect(
      fork({
        threadId: "t1",
        fromMessageId: "m2",
        checkout: { kind: "newWorktree", branch: "fork/another-approach" },
        title: "Try another approach",
      }),
    ).toMatchObject({ fromMessageId: "m2", checkout: { kind: "newWorktree" } });

    const open = Schema.decodeUnknownSync(GramRpcs.requests.get("terminal.open")!.payloadSchema);
    expect(open({ threadId: "t1", cols: 120, rows: 30 })).toEqual({
      threadId: "t1",
      cols: 120,
      rows: 30,
    });
    const resize = Schema.decodeUnknownSync(
      GramRpcs.requests.get("terminal.resize")!.payloadSchema,
    );
    expect(() => resize({ terminalId: "term-1", cols: 0, rows: 30 })).toThrow();
    const file = Schema.decodeUnknownSync(GramRpcs.requests.get("fs.file")!.payloadSchema);
    expect(() => file({ path: "/repo/a.ts", maxBytes: 0 })).toThrow();
  });

  it("decodes the orchestration payloads", () => {
    expect(payloadOf("workspace.list")(undefined)).toBeUndefined();
    const save = payloadOf("workspace.save");
    const saveErrors = GramRpcs.requests.get("workspace.save")!.errorSchema as Schema.Codec<
      unknown,
      unknown
    >;
    expectRoundTrip(
      saveErrors,
      new InvalidState({ message: "A workspace with that name already exists." }),
    );
    expectRoundTrip(saveErrors, new NotImplemented({ rpc: "workspace.save" }));
    expect(save({ name: "Shop", projectIds: ["p1", "p2"], homeProjectId: "p1" })).toEqual({
      name: "Shop",
      projectIds: ["p1", "p2"],
      homeProjectId: "p1",
    });
    expect(save({ id: "w1", name: "Shop", projectIds: ["p1"], homeProjectId: "p1" })).toMatchObject(
      { id: "w1" },
    );
    expect(() => save({ name: "Shop", projectIds: [], homeProjectId: "p1" })).toThrow();
    const saveSchema = (
      GramRpcs.requests as ReadonlyMap<string, { payloadSchema: Schema.Top }>
    ).get("workspace.save")!.payloadSchema as Schema.Codec<unknown, unknown>;
    expectRoundTrip(
      saveSchema,
      save({
        name: "Shop",
        projectIds: ["p1"],
        homeProjectId: "p1",
        charter: {
          maxConcurrentWorkers: 4,
          autonomy: "full",
          workerMode: "auto",
          orchestratorModel: { agent: "claude", model: "opus", variant: "high" },
          workerModels: [
            { agent: "claude", model: "opus", variant: "high", useFor: "implementation" },
          ],
        },
      }),
    );
    expect(() =>
      save({
        name: "Shop",
        projectIds: ["p1"],
        homeProjectId: "p1",
        charter: { maxConcurrentWorkers: 0 },
      }),
    ).toThrow();
    expect(payloadOf("workspace.remove")({ workspaceId: "w1" })).toEqual({ workspaceId: "w1" });
    const open = payloadOf("orchestrator.open");
    expect(open({ workspaceId: "w1" })).toEqual({ workspaceId: "w1" });
    expect(open({ projectId: "p1" })).toEqual({ projectId: "p1" });
    const startTask = payloadOf("workspace.startTask");
    const task = {
      target: { projectId: "p1" },
      input: { text: "Fix the flaky retry test" },
      direct: { projectId: "p1", base: "main" },
    };
    expect(startTask(task)).toEqual(task);
    expect(startTask({ target: { workspaceId: "w1" }, input: { text: "x" } })).toEqual({
      target: { workspaceId: "w1" },
      input: { text: "x" },
    });
    expect(() => startTask({ target: {}, input: { text: "x" } })).toThrow();
    expect(() => startTask({ ...task, draftId: "../../etc" })).toThrow();
    const setCharter = payloadOf("orchestrator.setCharter");
    const charter = {
      maxConcurrentWorkers: 2,
      workerMode: "acceptEdits",
    };
    expect(setCharter({ workspaceId: "w1", charter })).toEqual({ workspaceId: "w1", charter });
    expect(() =>
      setCharter({ workspaceId: "w1", charter: { ...charter, maxConcurrentWorkers: 0 } }),
    ).toThrow();
    expect(payloadOf("orchestrator.setPaused")({ workspaceId: "w1", paused: true })).toEqual({
      workspaceId: "w1",
      paused: true,
    });
    expect(() => payloadOf("orchestrator.setPaused")({ workspaceId: "w1" })).toThrow();
    expect(payloadOf("orchestrator.ledger")({ workspaceId: "w1" })).toEqual({ workspaceId: "w1" });
    expect(payloadOf("thread.detach")({ threadId: "t1" })).toEqual({ threadId: "t1" });
    expect(payloadOf("orchestrator.releaseWorker")({ threadId: "t1" })).toEqual({
      threadId: "t1",
    });
    expect(() => payloadOf("orchestrator.releaseWorker")({})).toThrow();
    expectRoundTrip(NotFound, new NotFound({ entity: "workspace", id: "w1" }));
  });

  it("decodes the stage, group, handoff, ledger-stream and grouped-answer payloads", () => {
    const setStage = payloadOf("orchestrator.setStage");
    const staged = {
      workspaceId: "w1",
      feature: "cart",
      stage: "build",
      plan: ["contract", "build"],
      note: "agreed",
    };
    expect(setStage(staged)).toEqual(staged);
    expect(setStage({ workspaceId: "w1", group: "0-4", stage: "rc" })).toEqual({
      workspaceId: "w1",
      group: "0-4",
      stage: "rc",
    });
    expect(() => setStage({ workspaceId: "w1", feature: "cart" })).toThrow();
    const setGroup = payloadOf("orchestrator.setGroup");
    expect(setGroup({ workspaceId: "w1", feature: "cart", group: "0-4" })).toMatchObject({
      group: "0-4",
    });
    expect(setGroup({ workspaceId: "w1", feature: "cart" })).toEqual({
      workspaceId: "w1",
      feature: "cart",
    });
    expect(() => setGroup({ workspaceId: "w1" })).toThrow();
    expect(payloadOf("orchestrator.handoff")({ workspaceId: "w1" })).toEqual({ workspaceId: "w1" });
    expect(() => payloadOf("orchestrator.handoff")({})).toThrow();
    expect(
      payloadOf("orchestrator.switch")({
        workspaceId: "w1",
        model: { agent: "claude", model: "Exact-Custom-Opus5.5" },
      }),
    ).toEqual({ workspaceId: "w1", model: { agent: "claude", model: "Exact-Custom-Opus5.5" } });
    expect(() => payloadOf("orchestrator.switch")({ workspaceId: "w1" })).toThrow();
    expect(payloadOf("orchestrator.cancelSwitch")({ workspaceId: "w1" })).toEqual({
      workspaceId: "w1",
    });
    expect(payloadOf("orchestrator.retrySwitch")({ workspaceId: "w1" })).toEqual({
      workspaceId: "w1",
    });

    const watch = GramRpcs.requests.get("orchestrator.watchLedger")!;
    expect(RpcSchema.isStreamSchema(watch.successSchema)).toBe(true);
    expect(Schema.decodeUnknownSync(watch.payloadSchema)({ workspaceId: "w1" })).toEqual({
      workspaceId: "w1",
    });

    const many = GramRpcs.requests.get("thread.respondMany")!;
    const allow = { kind: "approval", decision: "allow", scope: "once" };
    const answers = [
      { threadId: "t1", requestId: "r1", answer: allow },
      { threadId: "t2", requestId: "r2", answer: allow },
    ];
    expect(Schema.decodeUnknownSync(many.payloadSchema)({ answers })).toEqual({ answers });
    expect(() =>
      Schema.decodeUnknownSync(many.payloadSchema)({ answers: [{ threadId: "t1" }] }),
    ).toThrow();
    const results = [
      { threadId: "t1", requestId: "r1", ok: true },
      { threadId: "t2", requestId: "r2", ok: false, error: "That thread is closed." },
    ];
    expect(
      JSON.parse(
        JSON.stringify(
          Schema.encodeSync(many.successSchema)(
            Schema.decodeUnknownSync(many.successSchema)(results),
          ),
        ),
      ),
    ).toEqual(results);
  });

  it("decodes the dream and memory payloads", () => {
    const dreamId = "dream-0001";
    expect(payloadOf("dream.preview")({ workspaceId: "w1" })).toEqual({ workspaceId: "w1" });
    expect(() => payloadOf("dream.preview")({ workspaceId: "w1", perRepo: 0 })).toThrow();
    const start = payloadOf("dream.start");
    const full = {
      workspaceId: "w1",
      kind: "import",
      threadIds: ["t1"],
      agentSessions: [{ agent: "claude", cwd: "/repo", agentSessionId: "s1" }],
      instructions: "Focus on deploys.",
      model: { agent: "claude", model: "sonnet" },
      projectIds: ["p1"],
      perRepo: 30,
      includeMemory: true,
    };
    expect(start(full)).toEqual(full);
    expect(start({ workspaceId: "w1", kind: "dream" })).toEqual({
      workspaceId: "w1",
      kind: "dream",
    });
    expect(() => start({ workspaceId: "w1", kind: "nightmare" })).toThrow();
    expect(() => start({ ...full, instructions: "x".repeat(4097) })).toThrow();
    for (const tag of ["dream.review", "dream.cancel", "dream.discard"]) {
      expect(payloadOf(tag)({ dreamId })).toEqual({ dreamId });
      expect(() => payloadOf(tag)({ dreamId: "../x" })).toThrow();
    }
    const adopt = payloadOf("dream.adopt");
    expect(
      adopt({ dreamId, resolutions: { "decisions.md": "output", "goals.md": "current" } }),
    ).toEqual({
      dreamId,
      resolutions: { "decisions.md": "output", "goals.md": "current" },
    });
    expect(adopt({ dreamId, resolutions: { "decisions.md": "merged" } })).toEqual({
      dreamId,
      resolutions: { "decisions.md": "merged" },
    });
    expect(() => adopt({ dreamId, resolutions: { "decisions.md": "theirs" } })).toThrow();
    const merge = payloadOf("dream.merge");
    expect(merge({ dreamId, path: "decisions.md" })).toEqual({ dreamId, path: "decisions.md" });
    expect(() => merge({ dreamId })).toThrow();
    for (const tag of ["dream.list", "memory.list", "memory.versions"]) {
      expect(payloadOf(tag)({ workspaceId: "w1" })).toEqual({ workspaceId: "w1" });
    }
    const file = { workspaceId: "w1", path: "goals.md" };
    expect(payloadOf("memory.read")(file)).toEqual(file);
    expect(payloadOf("memory.delete")(file)).toEqual(file);
    expect(payloadOf("memory.write")({ ...file, content: "# Goals" })).toEqual({
      ...file,
      content: "# Goals",
    });
    expect(() => payloadOf("memory.write")(file)).toThrow();
    expect(payloadOf("memory.restore")({ workspaceId: "w1", version: "0003" })).toEqual({
      workspaceId: "w1",
      version: "0003",
    });
    expectRoundTrip(NotFound, new NotFound({ entity: "dream", id: dreamId }));
    expect(
      payloadOf("question.answer")({ workspaceId: "w1", question: "Keep both?", answer: "yes" }),
    ).toEqual({ workspaceId: "w1", question: "Keep both?", answer: "yes" });
    expect(() =>
      payloadOf("question.answer")({ workspaceId: "w1", question: "Keep both?", answer: "" }),
    ).toThrow();
  });

  it("decodes a thread.respond payload", () => {
    const rpc = GramRpcs.requests.get("thread.respond")!;
    const payload = Schema.decodeUnknownSync(rpc.payloadSchema)({
      threadId: "t1",
      requestId: "r1",
      answer: { kind: "approval", decision: "allow", scope: "session" },
    });
    expect(payload).toMatchObject({ answer: { scope: "session" } });
  });

  it("encodes a redacted gateway key as a plain string on the wire", () => {
    const rpc = GramRpcs.requests.get("profiles.setKey")!;
    const payload = Schema.decodeUnknownSync(rpc.payloadSchema)({
      profileId: "litellm",
      key: "sk-secret",
    });
    expect(String((payload as { key: unknown }).key)).not.toContain("sk-secret");
    expect(Redacted.value((payload as { key: Redacted.Redacted<string> }).key)).toBe("sk-secret");
    expect(JSON.parse(JSON.stringify(Schema.encodeSync(rpc.payloadSchema)(payload)))).toEqual({
      profileId: "litellm",
      key: "sk-secret",
    });
  });
});

describe("thread plans", () => {
  it("takes a user's edit of the plan", () => {
    const payload = payloadOf("thread.setPlan")({
      threadId: "t1",
      plan: {
        goal: "Make the retry test deterministic",
        steps: [
          { id: "s1", text: "Reproduce the flake", status: "done" },
          { text: "Ask jordan to review", status: "todo", pr: { number: 412 } },
          { id: "s3", text: "Merge #412", status: "todo", locked: false },
        ],
      },
    });
    expect(payload).toMatchObject({ plan: { steps: [{ id: "s1" }, {}, { locked: false }] } });
  });

  it("refuses a step over the length cap and a ninth step", () => {
    const long = { ...threadPlan, steps: [{ ...threadPlan.steps[0], text: "x".repeat(81) }] };
    expect(() => Schema.decodeUnknownSync(ThreadPlan)(long)).toThrow();
    const many = { ...threadPlan, steps: Array.from({ length: 9 }, () => threadPlan.steps[0]) };
    expect(() => Schema.decodeUnknownSync(ThreadPlan)(many)).toThrow();
  });
});
