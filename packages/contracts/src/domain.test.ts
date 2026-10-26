import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  Checkout,
  DEFAULT_HELPER,
  DEFAULT_HELPER_FALLBACK,
  GatewayProfile,
  helperChoice,
  helperContextAllowed,
  helperFallbackChoice,
  MAX_EXTRA_PRS,
  MAX_HIDDEN_PRS,
  EXAMPLE_GATEWAY,
  normalizeThreadPrs,
  PendingRequest,
  PermissionUpdate,
  RequestAnswer,
  sameGatewayURL,
  samePr,
  Thread,
  ThreadLabels,
  ThreadStatus,
  sidebarGroup,
  BoundPr,
  MAX_PR_DEPENDENCIES,
  mergeAfterDependencies,
  MONITOR_MARK_REVIEWS_MAX,
} from "./domain.ts";
import {
  mergeStateAllowsMerge,
  requiredChecksGreen,
  requiredChecksOf,
  type PrStatus,
} from "./git.ts";
import { hiddenEntryOf, narrowHiddenPrs, prAttentionOf, resurfaces } from "./hidden-prs.ts";
import { expectRoundTrip, readFixture } from "./test-utils.ts";

const decodeRequest = Schema.decodeUnknownSync(PendingRequest);

interface CanUseToolNote {
  toolName: string;
  input: Record<string, unknown>;
  opts: {
    suggestions?: unknown[];
    blockedPath?: string;
    decisionReason?: string;
    displayName: string;
    description?: string;
    toolUseID: string;
    requestId: string;
  };
}

const canUseToolNotes = (fixture: string): CanUseToolNote[] =>
  readFixture(fixture)
    .filter((line) => line["note"] === "canUseTool")
    .map((line) => line["data"] as CanUseToolNote);

/** The mapping T3's adapter performs, kept minimal: SDK callback args → PendingRequest wire shape. */
const fromCanUseTool = ({ toolName, input, opts }: CanUseToolNote): unknown =>
  toolName === "ExitPlanMode"
    ? {
        kind: "plan",
        id: opts.requestId,
        toolUseId: opts.toolUseID,
        plan: input["plan"],
        planFilePath: input["planFilePath"],
      }
    : {
        kind: "approval",
        id: opts.requestId,
        toolUseId: opts.toolUseID,
        toolName,
        displayName: opts.displayName,
        input,
        ...(opts.description !== undefined && { description: opts.description }),
        ...(opts.decisionReason !== undefined && { decisionReason: opts.decisionReason }),
        ...(opts.blockedPath !== undefined && { blockedPath: opts.blockedPath }),
        suggestions: opts.suggestions ?? [],
      };

const extras = (count: number) =>
  Array.from({ length: count }, (_, n) => ({ repo: "o/r", number: n + 1, monitor: false }));

const hidden = (count: number) =>
  Array.from({ length: count }, (_, n) => ({ repo: "o/r", number: n + 1 }));

describe("PendingRequest from recorded canUseTool payloads", () => {
  it("decodes approvals with addRules + addDirectories suggestions and a blocked path", () => {
    const notes = canUseToolNotes("p05b-local-redirect.jsonl");
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      const request = decodeRequest(fromCanUseTool(note));
      expect(request.kind).toBe("approval");
      if (request.kind !== "approval") continue;
      expect(request.blockedPath).toBe("/synthetic/project/hi.txt");
      expect(request.suggestions.map((s) => s.type)).toEqual(["addRules", "addDirectories"]);
      expectRoundTrip(PendingRequest, request);
    }
  });

  it("decodes approvals with a decisionReason and no blocked path", () => {
    const [note] = canUseToolNotes("p05c-approvals-no-path.jsonl");
    const request = decodeRequest(fromCanUseTool(note!));
    expect(request).toMatchObject({
      kind: "approval",
      decisionReason: "This command requires approval",
      suggestions: [{ type: "addRules", destination: "localSettings" }],
    });
    expect(request).not.toHaveProperty("blockedPath");
  });

  it("decodes ExitPlanMode as a plan request", () => {
    const [note] = canUseToolNotes("p06-exit-plan-mode.jsonl");
    const request = decodeRequest(fromCanUseTool(note!));
    expect(request.kind).toBe("plan");
    expect(request).toMatchObject({
      planFilePath: "/synthetic/home/.claude/plans/fixture-plan.md",
    });
  });

  it("decodes an AskUserQuestion tool input as a question request", () => {
    const toolUse = readFixture("p07-ask-user-question.jsonl")
      .flatMap((line) => {
        const msg = line["msg"] as { type?: string; message?: { content?: unknown[] } } | undefined;
        return msg?.type === "assistant" ? (msg.message?.content ?? []) : [];
      })
      .find(
        (block): block is { id: string; name: string; input: { questions: unknown } } =>
          (block as { name?: string }).name === "AskUserQuestion",
      );
    expect(toolUse).toBeDefined();
    const request = decodeRequest({
      kind: "question",
      id: "req-1",
      toolUseId: toolUse!.id,
      questions: toolUse!.input.questions,
    });
    expect(request).toMatchObject({
      kind: "question",
      questions: [
        { header: "File name", multiSelect: false, options: [{ label: "alpha.txt" }, {}] },
      ],
    });
    expectRoundTrip(PendingRequest, request);
  });

  it("rejects an approval without suggestions", () => {
    expect(() =>
      decodeRequest({
        kind: "approval",
        id: "r",
        toolName: "Bash",
        displayName: "Bash",
        input: {},
      }),
    ).toThrow();
  });
});

const model = (id: string) => ({ id, name: id });

describe("gateway helpers", () => {
  it("requires explicit context consent for the exact gateway endpoint", () => {
    const profile: GatewayProfile = { ...EXAMPLE_GATEWAY, keyRef: "profile:example", models: [] };
    expect(helperContextAllowed(profile, "title")).toBe(false);
    expect(helperContextAllowed(profile, "plan")).toBe(false);
    const opening = {
      ...profile,
      helperContext: { baseURL: profile.baseURL, scope: "opening" as const },
    };
    expect(helperContextAllowed(opening, "title")).toBe(true);
    expect(helperContextAllowed(opening, "recap")).toBe(false);
    const all = {
      ...opening,
      helperContext: { ...opening.helperContext, scope: "conversation" as const },
    };
    expect(helperContextAllowed(all, "plan")).toBe(true);
    for (const baseURL of [
      "https://elsewhere.example/v1",
      profile.baseURL + "/other",
      profile.baseURL.replace("https:", "http:"),
    ]) {
      expect(helperContextAllowed({ ...all, baseURL }, "title")).toBe(false);
    }
    expectRoundTrip(GatewayProfile, all);
  });
  it("picks the helper: the user's model and effort, else Haiku 5.5 when listed, else the first model", () => {
    const haiku = model(DEFAULT_HELPER.model);
    expect(DEFAULT_HELPER.model).toBe("claude-haiku-5.5-eu");
    expect(helperChoice({ models: [model("a"), haiku] })).toEqual(DEFAULT_HELPER);
    expect(helperChoice({ models: [model("a"), model("b")] })).toEqual({ model: "a" });
    expect(helperChoice({ models: [] })).toBeUndefined();
    // The first model an agent could run, not an embedding model that happens to come first.
    expect(
      helperChoice({
        models: [
          { id: "text-embedding-3-large", name: "e", info: { mode: "embedding" } },
          model("b"),
        ],
      }),
    ).toEqual({ model: "b" });
    // A gateway serving only the previous defaults gets its first model, not an unlisted default.
    const luna = model("gpt-6-luna");
    expect(helperChoice({ models: [model("a"), luna] })).toEqual({ model: "a" });
    // Someone who picked the previous default keeps it, with their effort.
    expect(helperChoice({ models: [luna], helperModel: luna.id, helperEffort: "high" })).toEqual({
      model: luna.id,
      effort: "high",
    });
    // A pick wins over the default even when it is listed, and carries only the effort it was given.
    expect(helperChoice({ models: [haiku], helperModel: "gemini-flash" })).toEqual({
      model: "gemini-flash",
      effort: undefined,
    });
    expect(helperChoice({ models: [haiku], helperModel: "a", helperEffort: "low" })).toEqual({
      model: "a",
      effort: "low",
    });
  });

  it("falls back to Luna when listed, to the user's pick, or to nothing when they chose none", () => {
    const primary = model(DEFAULT_HELPER.model);
    const fallback = model(DEFAULT_HELPER_FALLBACK.model);
    expect(DEFAULT_HELPER_FALLBACK).toEqual({ model: "gpt-6-luna", effort: "high" });
    expect(helperFallbackChoice({ models: [primary, fallback] })).toEqual(DEFAULT_HELPER_FALLBACK);
    expect(helperFallbackChoice({ models: [primary] })).toBeUndefined();
    // The fallback picked as the primary isn't also its own fallback.
    expect(
      helperFallbackChoice({ models: [primary, fallback], helperModel: fallback.id }),
    ).toBeUndefined();
    expect(
      helperFallbackChoice({ models: [primary, fallback], helperFallback: null }),
    ).toBeUndefined();
    const pick = { model: "gpt-6-luna", effort: "low" } as const;
    expect(helperFallbackChoice({ models: [], helperFallback: pick })).toEqual(pick);
  });

  it("round-trips a profile with a helper model and effort", () => {
    expectRoundTrip(GatewayProfile, {
      ...EXAMPLE_GATEWAY,
      keyRef: "profile:example",
      models: [model("gpt-5.6-luna")],
      default: true,
      helperModel: "gpt-5.6-luna",
      helperEffort: "high",
      helperFallback: { model: "a-claude-haiku-4.5" },
    });
    expectRoundTrip(GatewayProfile, {
      ...EXAMPLE_GATEWAY,
      keyRef: "",
      models: [],
      helperFallback: null,
    });
  });

  it("round-trips a model with the gateway catalog's description of it", () => {
    expectRoundTrip(GatewayProfile, {
      ...EXAMPLE_GATEWAY,
      keyRef: "",
      models: [
        {
          id: "gpt-6.1-sol",
          name: "gpt-6.1-sol",
          variants: ["low", "max"],
          info: {
            mode: "chat",
            deprecated: false,
            restricted: false,
            tools: true,
            reasoning: true,
            noneEffort: false,
            xhighEffort: true,
            maxEffort: true,
            webSearch: false,
            maxInputTokens: 922_000,
          },
        },
      ],
    });
  });

  it("matches a gateway address whatever its case, padding or trailing slashes", () => {
    expect(
      sameGatewayURL(` ${EXAMPLE_GATEWAY.baseURL.toUpperCase()}// `, EXAMPLE_GATEWAY.baseURL),
    ).toBe(true);
    expect(sameGatewayURL(`${EXAMPLE_GATEWAY.baseURL}/v2`, EXAMPLE_GATEWAY.baseURL)).toBe(false);
    expect(sameGatewayURL("///", "")).toBe(true);
    // Linear in its input: a regex here went quadratic on a run of slashes (CodeQL js/polynomial-redos).
    const started = performance.now();
    expect(sameGatewayURL(`${"/".repeat(200_000)}x`, "y")).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("round-trips", () => {
  it("PermissionUpdate: every variant", () => {
    const updates = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "echo *" }],
        behavior: "allow",
        destination: "localSettings",
      },
      {
        type: "replaceRules",
        rules: [{ toolName: "Read" }],
        behavior: "ask",
        destination: "projectSettings",
      },
      {
        type: "removeRules",
        rules: [{ toolName: "Edit" }],
        behavior: "deny",
        destination: "userSettings",
      },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      { type: "addDirectories", directories: ["/tmp/a"], destination: "session" },
      { type: "removeDirectories", directories: ["/tmp/a"], destination: "cliArg" },
    ] as const;
    for (const update of updates) expectRoundTrip(PermissionUpdate, update);
  });

  it("RequestAnswer: every variant", () => {
    const answers: RequestAnswer[] = [
      { kind: "approval", decision: "allow", scope: "always" },
      { kind: "approval", decision: "deny", scope: "once", message: "not now" },
      { kind: "question", answers: { "Which file name should I use?": ["beta.txt"] } },
      { kind: "plan", decision: "approve", mode: "acceptEdits" },
      { kind: "plan", decision: "reject", message: "split it up" },
    ];
    for (const answer of answers) expectRoundTrip(RequestAnswer, answer);
  });

  it("Thread with a worktree checkout", () => {
    const thread = Schema.decodeUnknownSync(Thread)({
      id: "t1",
      projectId: "p1",
      title: "fix-flaky-test",
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: {
        kind: "worktree",
        path: "/repo/.worktrees/fix-flaky",
        branch: "fix/flaky",
        base: "main",
        repoRoot: "/repo",
      },
      forkedFrom: { agentSessionId: "0b7c", codexHome: "user" },
      codexHome: "gateway",
      lastError: {
        kind: "gatewayRefused",
        httpStatus: 429,
        code: "responseTooManyFailedAttempts",
        retryable: false,
        text: "Gateway refused the request: no deployment supports this request (HTTP 429)",
        turnId: "turn-1",
        at: 4,
      },
      labels: ["l1"],
      unread: true,
      completedAt: 3,
      completedReason: "prMerged",
      settledMerge: {
        merged: [{ number: 412, url: "https://github.com/o/r/pull/412" }],
        head: "abc",
        changesToken: "t1",
      },
      boundPr: { repo: "o/r", number: 412, monitor: true },
      extraPrs: [{ repo: "o/other", number: 7, monitor: false }],
      hiddenPrs: [
        { repo: "o/other", number: 7, state: "MERGED" },
        { repo: "o/r", number: 412, state: "OPEN", seen: ["ci:abc", "conflicts"] },
      ],
      pinned: false,
      parked: false,
      createdAt: 1,
      lastActivityAt: 2,
    });
    expectRoundTrip(Thread, thread);
    expect(() =>
      Schema.decodeUnknownSync(Thread)({ ...thread, completedReason: "bored" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Thread)({
        ...thread,
        lastError: { kind: "unknown", retryable: true, text: "x".repeat(301), at: 4 },
      }),
    ).toThrow();
    expectRoundTrip(Checkout, { kind: "main", path: "/repo" });
  });

  it("Thread with orchestration fields, and one without them", () => {
    const plain = {
      id: "t1",
      projectId: "p1",
      title: "t",
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "auto",
      checkout: { kind: "main", path: "/repo" },
      labels: [],
      unread: false,
      pinned: false,
      parked: false,
      createdAt: 1,
      lastActivityAt: 2,
    };
    const bare = Schema.decodeUnknownSync(Thread)(plain);
    expect("role" in bare || "workspaceId" in bare || "spawnedBy" in bare).toBe(false);
    expectRoundTrip(Thread, bare);
    expectRoundTrip(
      Thread,
      Schema.decodeUnknownSync(Thread)({ ...plain, role: "orchestrator", workspaceId: "w1" }),
    );
    const worker = Schema.decodeUnknownSync(Thread)({
      ...plain,
      workspaceId: "w1",
      spawnedBy: { threadId: "t0", feature: "checkout-flow" },
      ownedBranches: [
        { path: "/repo/.worktrees/checkout-flow", branch: "feat/checkout-flow" },
        { path: "/repo/.worktrees/checkout-flow", branch: "feat/checkout-stack" },
      ],
    });
    expect(worker.spawnedBy).toEqual({ threadId: "t0", feature: "checkout-flow" });
    expectRoundTrip(Thread, worker);
    expect(() => Schema.decodeUnknownSync(Thread)({ ...plain, role: "worker" })).toThrow();
  });

  it("rejects a thread past the extra or hidden PR caps", () => {
    const thread = {
      id: "t1",
      projectId: "p1",
      title: "t",
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: { kind: "main", path: "/repo" },
      labels: [],
      unread: false,
      pinned: false,
      parked: false,
      createdAt: 1,
      lastActivityAt: 2,
    };
    expect(() =>
      Schema.decodeUnknownSync(Thread)({ ...thread, extraPrs: extras(MAX_EXTRA_PRS) }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Thread)({ ...thread, extraPrs: extras(MAX_EXTRA_PRS + 1) }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Thread)({ ...thread, hiddenPrs: hidden(MAX_HIDDEN_PRS) }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Thread)({ ...thread, hiddenPrs: hidden(MAX_HIDDEN_PRS + 1) }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Thread)({
        ...thread,
        hiddenPrs: [{ repo: "o/r", number: 1, state: "DRAFT" }],
      }),
    ).toThrow();
  });

  it("normalizeThreadPrs lists each followed PR once", () => {
    const thread = {
      boundPr: { repo: "o/r", number: 4, monitor: true },
      extraPrs: [
        { repo: "O/R", number: 4, monitor: false },
        { repo: "o/other", number: 7, monitor: false },
        { repo: "o/other", number: 7, monitor: true },
      ],
    } as unknown as Thread;
    expect(normalizeThreadPrs(thread).extraPrs).toEqual([
      { repo: "o/other", number: 7, monitor: false },
    ]);
    const only = { ...thread, extraPrs: [thread.extraPrs![0]!] } as Thread;
    expect("extraPrs" in normalizeThreadPrs(only)).toBe(false);
    const clean = { ...thread, extraPrs: [thread.extraPrs![1]!] } as Thread;
    expect(normalizeThreadPrs(clean)).toBe(clean);
  });

  it("normalizeThreadPrs leaves an orchestrator following, watching and babysitting nothing", () => {
    const orchestrator = {
      role: "orchestrator",
      title: "Orchestrator",
      boundPr: { repo: "o/r", number: 4, monitor: true, reviewMonitor: true },
      extraPrs: [{ repo: "o/other", number: 7, monitor: false }],
      babysit: { phase: "watching" },
      rereviewRequestedOn: "abc123",
    } as unknown as Thread;
    expect(normalizeThreadPrs(orchestrator)).toEqual({
      role: "orchestrator",
      title: "Orchestrator",
    });
    const bare = { role: "orchestrator", title: "Orchestrator" } as unknown as Thread;
    expect(normalizeThreadPrs(bare)).toBe(bare);
  });

  it("keeps what a binding's monitors saw, and caps the people's reviews it remembers", () => {
    const seen = {
      head: "a1",
      ci: "passing",
      checks: "pending",
      verdict: "approved",
      mergeState: "BLOCKED",
      reviewId: "PRR_1",
      humanReviews: ["PRR_h1"],
    } as const;
    expectRoundTrip(BoundPr, { repo: "o/r", number: 4, monitor: true, seen });
    const dependency = {
      repo: "o/base",
      number: 3,
      setBy: "orchestrator",
      setAt: 1,
      seen: { state: "open", head: "b1" },
    } as const;
    const bound = {
      repo: "o/r",
      number: 4,
      monitor: false,
      dependsOn: [dependency, { ...dependency, number: 5, setBy: "thread", mergeAfter: false }],
    } as const;
    expectRoundTrip(BoundPr, bound);
    expect(mergeAfterDependencies(bound).map((each) => each.number)).toEqual([3]);
    expect(() =>
      Schema.decodeUnknownSync(BoundPr)({
        ...bound,
        dependsOn: Array.from({ length: MAX_PR_DEPENDENCIES + 1 }, () => dependency),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BoundPr)({
        repo: "o/r",
        number: 4,
        monitor: true,
        seen: { humanReviews: Array.from({ length: MONITOR_MARK_REVIEWS_MAX + 1 }, String) },
      }),
    ).toThrow();
  });

  it("samePr ignores the case of owner/repo but not the number", () => {
    expect(samePr({ repo: "EXAMPLE/Api", number: 4 }, { repo: "example/api", number: 4 })).toBe(
      true,
    );
    expect(samePr({ repo: "example/api", number: 4 }, { repo: "example/api", number: 5 })).toBe(
      false,
    );
    expect(samePr({ repo: "example/api", number: 4 }, { repo: "example/web", number: 4 })).toBe(
      false,
    );
  });

  it("rejects an empty branded id and an unknown checkout kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(PendingRequest)({ kind: "plan", id: "", plan: "" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(Checkout)({ kind: "branch", path: "/" })).toThrow();
  });

  it("caps thread labels at one", () => {
    expectRoundTrip(ThreadLabels, Schema.decodeUnknownSync(ThreadLabels)(["l1"]));
    expect(() => Schema.decodeUnknownSync(ThreadLabels)(["l1", "l2"])).toThrow();
  });

  it("approval scopes are optional and validated", () => {
    const approval = {
      kind: "approval",
      id: "r1",
      toolName: "mcp__gram__set_auto_merge",
      displayName: "Set auto-merge",
      input: {},
      suggestions: [],
      scopes: ["once"],
    };
    expectRoundTrip(PendingRequest, decodeRequest(approval));
    expect(() => decodeRequest({ ...approval, scopes: ["forever"] })).toThrow();
    expectRoundTrip(
      PendingRequest,
      decodeRequest({
        ...approval,
        scopes: ["once", "always"],
        browseHost: "organization.example.invalid",
      }),
    );
  });
});

describe("sidebarGroup", () => {
  it("maps every status to a sidebar group", () => {
    const groups = Object.fromEntries(
      ThreadStatus.literals.map((s) => [s, sidebarGroup({ status: s })]),
    );
    expect(groups).toEqual({
      cold: "idle",
      starting: "working",
      idle: "idle",
      running: "working",
      needsApproval: "needsYou",
      needsInput: "needsYou",
      error: "needsYou",
      ended: "settled",
    });
  });

  it("settles completed threads only while nothing is happening", () => {
    expect(sidebarGroup({ status: "idle", completedAt: 1 })).toBe("settled");
    expect(sidebarGroup({ status: "cold", completedAt: 1 })).toBe("settled");
    expect(sidebarGroup({ status: "running", completedAt: 1 })).toBe("working");
    expect(sidebarGroup({ status: "needsInput", completedAt: 1 })).toBe("needsYou");
  });

  it("puts a stopped babysit in Needs you once the agent is idle", () => {
    expect(sidebarGroup({ status: "idle", babysit: { phase: "stopped" } })).toBe("needsYou");
    expect(sidebarGroup({ status: "cold", babysit: { phase: "stopped" } })).toBe("needsYou");
    expect(sidebarGroup({ status: "running", babysit: { phase: "stopped" } })).toBe("working");
    expect(sidebarGroup({ status: "idle", babysit: { phase: "watching" } })).toBe("idle");
    expect(sidebarGroup({ status: "idle", completedAt: 1, babysit: { phase: "done" } })).toBe(
      "settled",
    );
  });
});

describe("hidden PRs", () => {
  const open: PrStatus = {
    number: 4,
    state: "OPEN",
    url: "https://github.com/ANT1OFF/gram/pull/4",
    title: "Port the rewrite work",
    isDraft: false,
    checks: "passing",
    headMatches: true,
    aheadOfPr: false,
    headRefOid: "h1",
  };
  const bot = {
    bots: ["example-code-review[bot]"],
    verdictOnHead: "changesRequested",
    reviewedHead: true,
    roundInFlight: false,
    latestReviewId: "r1",
    threads: { unresolved: 1, blockers: 1, suggestions: 0, outdatedUnresolved: 0 },
  } satisfies PrStatus["review"];
  const ref = { repo: "ANT1OFF/gram", number: 4 };

  it("names what needs the user on an open PR, and nothing on a merged one", () => {
    expect(prAttentionOf(open)).toEqual([]);
    expect(
      prAttentionOf({
        ...open,
        checks: "failing",
        review: bot,
        reviewDecision: "CHANGES_REQUESTED",
        mergeState: "DIRTY",
      }),
    ).toEqual(["ci:h1", "bot:r1", "changes:h1", "conflicts"]);
    expect(prAttentionOf({ ...open, state: "MERGED", checks: "failing" })).toEqual([]);
    // A red check nobody requires can't hold the merge up, so it doesn't ask for the user.
    expect(prAttentionOf({ ...open, checks: "failing", requiredChecks: "passing" })).toEqual([]);
  });

  it("reads readiness off the required checks, and merges past UNSTABLE", () => {
    const windowsRed = { checks: "failing", requiredChecks: "passing" } as const;
    expect(requiredChecksOf(windowsRed)).toBe("passing");
    expect(requiredChecksOf({ checks: "failing" })).toBe("failing");
    expect(requiredChecksGreen(windowsRed)).toBe(true);
    expect(requiredChecksGreen({ checks: "none" })).toBe(true);
    expect(requiredChecksGreen({ checks: "passing", requiredChecks: "pending" })).toBe(false);
    expect(
      ["CLEAN", "UNSTABLE", "BLOCKED", "BEHIND", "DIRTY", undefined].map(mergeStateAllowsMerge),
    ).toEqual([true, true, false, false, false, false]);
  });

  it("comes back for a new failure, round, conflict or a reopen, but not for merging", () => {
    const quiet = hiddenEntryOf(ref, open);
    expect(quiet).toEqual({ ...ref, state: "OPEN" });
    expect(resurfaces(quiet, open)).toBe(false);
    expect(resurfaces(quiet, { ...open, checks: "failing" })).toBe(true);
    expect(resurfaces(quiet, { ...open, review: bot })).toBe(true);
    expect(resurfaces(quiet, { ...open, mergeState: "DIRTY" })).toBe(true);
    expect(resurfaces(quiet, { ...open, state: "MERGED" })).toBe(false);

    // What was already wrong when it was hidden doesn't bring it back; the same thing anew does.
    const failing = hiddenEntryOf(ref, { ...open, checks: "failing", review: bot });
    expect(failing.seen).toEqual(["ci:h1", "bot:r1"]);
    expect(resurfaces(failing, { ...open, checks: "failing", review: bot })).toBe(false);
    expect(resurfaces(failing, { ...open, checks: "failing", headRefOid: "h2" })).toBe(true);
    expect(resurfaces(failing, { ...open, review: { ...bot, latestReviewId: "r2" } })).toBe(true);
    // A badge fetched by number has no bot review: a change request still standing on a new head.
    const asked = hiddenEntryOf(ref, { ...open, reviewDecision: "CHANGES_REQUESTED" });
    expect(
      resurfaces(asked, { ...open, reviewDecision: "CHANGES_REQUESTED", headRefOid: "h2" }),
    ).toBe(true);

    expect(resurfaces(hiddenEntryOf(ref, { ...open, state: "CLOSED" }), open)).toBe(true);
    expect(resurfaces(hiddenEntryOf(ref, { ...open, state: "MERGED" }), open)).toBe(true);
  });

  it("forgets what cleared, so it coming back again brings the row back", () => {
    const failing = hiddenEntryOf(ref, { ...open, checks: "failing" });
    // Still failing: nothing to narrow.
    expect(narrowHiddenPrs([failing], [{ ...open, checks: "failing" }])).toBeUndefined();
    // Rerun under way: the failure is forgotten, and the next one on the same head is news.
    const rerun = narrowHiddenPrs([failing], [{ ...open, checks: "pending" }]);
    expect(rerun).toEqual([{ ...ref, state: "OPEN" }]);
    expect(resurfaces(rerun![0]!, { ...open, checks: "failing" })).toBe(true);
    // Closed while hidden, so reopening brings it back.
    expect(narrowHiddenPrs([failing], [{ ...open, state: "CLOSED" }])).toEqual([
      { ...ref, state: "CLOSED" },
    ]);
    // An entry that asks to be seen is left for the user; one with no badge is left alone.
    expect(narrowHiddenPrs([hiddenEntryOf(ref, open)], [{ ...open, checks: "failing" }])).toBe(
      undefined,
    );
    const other = { ...open, number: 5, url: "https://github.com/ANT1OFF/gram/pull/5" };
    expect(narrowHiddenPrs([failing], [{ ...other, checks: "pending" }])).toBeUndefined();
    const elsewhere = {
      ...open,
      url: "https://github.com/example/other/pull/4",
      checks: "pending",
    };
    expect(narrowHiddenPrs([failing], [elsewhere as PrStatus])).toBeUndefined();
    // A badge that didn't read the reviews keeps the bot's change request as seen.
    const asked = hiddenEntryOf(ref, { ...open, checks: "failing", review: bot });
    const unread = narrowHiddenPrs([asked], [{ ...open, reviewUnread: true }]);
    expect(unread).toEqual([{ ...ref, state: "OPEN", seen: ["bot:r1"] }]);
    expect(resurfaces(unread![0]!, { ...open, review: bot })).toBe(false);
  });
});
