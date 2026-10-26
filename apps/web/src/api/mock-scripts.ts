import type {
  BackgroundTask,
  CompactionActivity,
  MessageMetadata,
  MessageOrigin,
  PendingRequest,
  PlanItem,
  Project,
  ProjectId,
  RequestAnswer,
  RequestId,
  GramUIMessage,
  GramUIMessageChunk,
  TaskId,
  Thread,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  TurnId,
  UsageSummary,
  UserInput,
} from "@gram/contracts";

import { mockEditMessages } from "./mock-edits";
import { MOCK_TOOL_IMAGE } from "./mock-files";
import { MOCK_DEPS_TURN } from "./mock-git";
import { mockPlans } from "./mock-plans";

/** One scripted beat of a mock agent turn. `wait` durations are scaled by the api's speed. */
export type Step =
  | { kind: "chunk"; messageId: string; chunk: GramUIMessageChunk }
  | { kind: "wait"; ms: number }
  /** Holds the script until `MockApi.release(name)`, when the page opted in; otherwise a no-op. */
  | { kind: "gate"; name: string }
  | { kind: "status"; status: ThreadStatus; detail?: string; compaction?: CompactionActivity }
  | { kind: "plan"; items: PlanItem[] }
  | { kind: "usage"; usage: UsageSummary }
  /** The agent's background tasks from here on, as its `backgroundTasks` level; stamped when run. */
  | { kind: "background"; tasks: Array<Omit<BackgroundTask, "startedAt">> }
  | { kind: "request"; request: PendingRequest; onAnswer: (answer: RequestAnswer) => Step[] };

export type Script = (input: UserInput, ids: () => string) => Step[];

const chunk = (messageId: string, c: GramUIMessageChunk): Step => ({
  kind: "chunk",
  messageId,
  chunk: c,
});
const wait = (ms: number): Step => ({ kind: "wait", ms });
const gate = (name: string): Step => ({ kind: "gate", name });
const background = (...tasks: Array<Omit<BackgroundTask, "startedAt">>): Step => ({
  kind: "background",
  tasks,
});
const status = (s: ThreadStatus, detail?: string): Step =>
  detail === undefined ? { kind: "status", status: s } : { kind: "status", status: s, detail };

export const start = (messageId: string, metadata: MessageMetadata = {}): Step[] => [
  chunk(messageId, {
    type: "start",
    messageId,
    messageMetadata: { createdAt: Date.now(), agentMessageIds: [`sdk-${messageId}`], ...metadata },
  }),
  chunk(messageId, { type: "start-step" }),
];

export const finish = (messageId: string): Step[] => [
  chunk(messageId, { type: "finish-step" }),
  chunk(messageId, { type: "finish", finishReason: "stop" }),
];

/** Streams `content` word by word. */
export function text(messageId: string, id: string, content: string, msPerWord = 28): Step[] {
  const words = content.match(/\S+\s*|\s+/g) ?? [];
  return [
    chunk(messageId, { type: "text-start", id }),
    ...words.flatMap((w) => [
      chunk(messageId, { type: "text-delta", id, delta: w }),
      wait(msPerWord),
    ]),
    chunk(messageId, { type: "text-end", id }),
  ];
}

export function reasoning(messageId: string, id: string, content: string): Step[] {
  const words = content.match(/\S+\s*/g) ?? [];
  return [
    chunk(messageId, { type: "reasoning-start", id }),
    ...words.flatMap((w) => [
      chunk(messageId, { type: "reasoning-delta", id, delta: w }),
      wait(18),
    ]),
    chunk(messageId, { type: "reasoning-end", id }),
  ];
}

export function toolCall(
  messageId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  ms = 400,
): Step[] {
  return [
    chunk(messageId, { type: "tool-input-start", toolCallId, toolName, providerExecuted: true }),
    wait(ms / 4),
    chunk(messageId, {
      type: "tool-input-available",
      toolCallId,
      toolName,
      input,
      providerExecuted: true,
    }),
    wait(ms),
  ];
}

export const toolResult = (messageId: string, toolCallId: string, output: unknown): Step =>
  chunk(messageId, { type: "tool-output-available", toolCallId, output, providerExecuted: true });

export const toolError = (messageId: string, toolCallId: string, errorText: string): Step =>
  chunk(messageId, { type: "tool-output-error", toolCallId, errorText, providerExecuted: true });

export const tool = (
  messageId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  output: unknown,
  ms?: number,
): Step[] => [
  ...toolCall(messageId, toolCallId, toolName, input, ms),
  toolResult(messageId, toolCallId, output),
];

// ---------------------------------------------------------------------------------------------
// Seed data

const now = Date.now();
const minutes = (n: number) => now - n * 60_000;

export const PROJECTS: Project[] = [
  {
    id: "p-api" as ProjectId,
    root: "/Users/dev/code/api",
    name: "api",
    repoRoot: "/Users/dev/code/api",
    bookmarked: true,
    lastOpenedAt: minutes(5),
  },
  {
    id: "p-web" as ProjectId,
    root: "/Users/dev/code/web",
    name: "web",
    repoRoot: "/Users/dev/code/web",
    bookmarked: false,
    lastOpenedAt: minutes(30),
  },
  {
    id: "p-docs" as ProjectId,
    root: "/Users/dev/code/docs",
    name: "docs",
    repoRoot: "/Users/dev/code/docs",
    bookmarked: false,
    lastOpenedAt: minutes(90),
  },
];

interface SeedThread {
  id: string;
  project: ProjectId;
  title: string;
  status: ThreadStatus;
  branch?: string;
  worktree?: boolean;
  lastActivity: number;
  flags?: Partial<
    Pick<Thread, "pinned" | "parked" | "unread" | "completedAt" | "labels" | "forkedFrom">
  >;
  /** The last turn's usage, as the server restores it for a thread that isn't running. */
  usage?: UsageSummary;
  /** Claude unless given. */
  model?: Thread["model"];
}

const SEEDS: SeedThread[] = [
  {
    id: "t-flaky",
    project: "p-api" as ProjectId,
    title: "Fix flaky retry test",
    status: "idle",
    branch: "fix/flaky-retry",
    worktree: true,
    lastActivity: minutes(2),
    usage: {
      tokens: { inputTokens: 58_400, outputTokens: 2_150, cacheReadTokens: 31_000 },
      contextWindow: 200_000,
      contextTokens: 61_200,
      costUsd: 0.42,
    },
  },
  {
    id: "t-question",
    project: "p-web" as ProjectId,
    title: "Pick a date library",
    status: "needsInput",
    branch: "feat/date-picker",
    worktree: true,
    lastActivity: minutes(12),
  },
  {
    id: "t-plan",
    project: "p-api" as ProjectId,
    title: "Plan the auth refactor",
    status: "needsApproval",
    branch: "refactor/auth",
    worktree: true,
    lastActivity: minutes(20),
  },
  {
    id: "t-docs",
    project: "p-docs" as ProjectId,
    title: "Rewrite the README",
    status: "running",
    branch: "docs/readme",
    lastActivity: minutes(1),
    flags: {
      labels: ["l-urgent" as Thread["labels"][number]],
      forkedFrom: { threadId: "t-flaky" as ThreadId },
    },
  },
  {
    id: "t-deps",
    project: "p-api" as ProjectId,
    title: "Bump dependencies",
    status: "idle",
    branch: "chore/deps",
    worktree: true,
    lastActivity: minutes(55),
  },
  {
    id: "t-release",
    project: "p-web" as ProjectId,
    title: "Release checklist",
    status: "idle",
    branch: "main",
    lastActivity: minutes(240),
    flags: { pinned: true },
  },
  {
    id: "t-dark",
    project: "p-web" as ProjectId,
    title: "Add dark mode toggle",
    status: "idle",
    branch: "feat/dark-mode",
    worktree: true,
    lastActivity: minutes(600),
    flags: { completedAt: minutes(600) },
  },
  {
    id: "t-grpc",
    project: "p-api" as ProjectId,
    title: "Spike: gRPC transport",
    status: "cold",
    branch: "spike/grpc",
    worktree: true,
    lastActivity: minutes(3000),
    flags: { parked: true },
  },
  {
    id: "t-background",
    project: "p-api" as ProjectId,
    title: "List the repo's files",
    status: "idle",
    branch: "main",
    lastActivity: minutes(45),
  },
  {
    id: "t-edits",
    project: "p-web" as ProjectId,
    title: "Fix the file tabs test",
    status: "idle",
    branch: "feat/file-tabs",
    worktree: true,
    lastActivity: minutes(50),
  },
  {
    id: "t-edits-codex",
    project: "p-api" as ProjectId,
    title: "Reset the rate limit per window",
    status: "idle",
    branch: "fix/rate-limit",
    worktree: true,
    lastActivity: minutes(52),
    model: { agent: "codex", model: "gpt-5-codex" },
  },
];

export function seedSummaries(): ThreadSummary[] {
  const plans = mockPlans(minutes);
  return SEEDS.map((seed) => {
    const project = PROJECTS.find((p) => p.id === seed.project)!;
    const path = seed.worktree
      ? `${project.root}/.worktrees/${seed.branch!.replaceAll("/", "-")}`
      : project.root;
    const thread: Thread = {
      id: seed.id as ThreadId,
      projectId: seed.project,
      title: seed.title,
      userNamed: false,
      model: seed.model ?? { agent: "claude", model: "opus" },
      mode: "default",
      checkout: {
        kind: seed.worktree ? "worktree" : "main",
        path,
        branch: seed.branch!,
        base: "main",
        ...(seed.worktree ? { repoRoot: project.root } : {}),
      },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: seed.lastActivity - 3_600_000,
      lastActivityAt: seed.lastActivity,
      ...seed.flags,
    };
    return {
      thread,
      status: seed.status,
      pendingRequests: seedRequests[seed.id] ?? [],
      queue: [],
      ...(seed.status === "running" ? { activity: "Writing README.md…" } : {}),
      ...(seed.usage === undefined ? {} : { usage: seed.usage }),
      ...(plans[seed.id] === undefined ? {} : { plan: plans[seed.id]! }),
    };
  });
}

const userMessage = (id: string, content: string, origin?: MessageOrigin): GramUIMessage => ({
  id,
  role: "user",
  metadata: { createdAt: now },
  parts: [
    { type: "text", text: content },
    ...(origin === undefined ? [] : [{ type: "data-thread-origin" as const, id, data: origin }]),
  ],
});

const assistantMessage = (id: string, content: string, turnId?: TurnId): GramUIMessage => ({
  id,
  role: "assistant",
  metadata: {
    createdAt: now,
    agent: "claude",
    model: "opus",
    agentMessageIds: [`sdk-${id}`],
    ...(turnId === undefined ? {} : { turnId }),
  },
  parts: [{ type: "step-start" }, { type: "text", text: content, state: "done" }],
});

export const QUESTION_REQUEST: PendingRequest = {
  kind: "question",
  id: "r-question" as RequestId,
  toolUseId: "toolu_question",
  questions: [
    {
      question: "Which date library should the picker use?",
      header: "Library",
      multiSelect: false,
      options: [
        { label: "date-fns", description: "Tree-shakeable functions, already a transitive dep." },
        { label: "Temporal polyfill", description: "Future-proof, but adds ~20 KB." },
        { label: "dayjs", description: "Tiny, moment-like API." },
      ],
    },
    {
      question: "Which locales must ship in the first release?",
      header: "Locales",
      multiSelect: true,
      options: [
        { label: "en-GB", description: "Default" },
        { label: "nb-NO", description: "Norwegian Bokmål" },
        { label: "de-DE", description: "German" },
      ],
    },
  ],
};

export const PLAN_REQUEST: PendingRequest = {
  kind: "plan",
  id: "r-plan" as RequestId,
  toolUseId: "toolu_plan",
  planFilePath: "~/.claude/plans/auth-refactor.md",
  plan: [
    "## Auth refactor",
    "",
    "1. Extract `SessionStore` from `middleware/auth.ts` behind an interface.",
    "2. Replace the in-memory token map with the Redis-backed store.",
    "3. Move cookie parsing into `lib/cookies.ts` and add unit tests.",
    "4. Delete the legacy `/login/basic` route once callers are migrated.",
  ].join("\n"),
};

const seedRequests: Record<string, PendingRequest[]> = {
  "t-question": [QUESTION_REQUEST],
  "t-plan": [PLAN_REQUEST],
};

export function seedMessages(threadId: string): GramUIMessage[] {
  const edits = mockEditMessages(threadId);
  if (edits !== undefined) return edits;
  switch (threadId) {
    case "t-question":
      return [
        userMessage("m-q1", "Add a date picker to the booking form."),
        assistantMessage("m-q2", "Before I wire it up, I need two decisions from you."),
      ];
    case "t-plan":
      return [
        userMessage("m-p1", "Plan how to split the auth middleware. Don't change code yet."),
        assistantMessage(
          "m-p2",
          "I've read `middleware/auth.ts` and its callers. Here's the plan.",
        ),
      ];
    case "t-deps":
      return [
        userMessage("m-d1", "Bump all minor versions and run the tests."),
        assistantMessage(
          "m-d2",
          "Bumped **14** packages. All tests pass.\n\n| Package | From | To |\n|---|---|---|\n| vitest | 5.0.0 | 5.1.2 |\n| zod | 4.6.5 | 4.7.0 |",
          MOCK_DEPS_TURN,
        ),
      ];
    case "t-dark":
      return [
        // Sent by the planning thread through `send_message`, so the transcript names it. Its
        // thread links are one to a thread the app has and one to a thread since closed.
        userMessage(
          "m-k1",
          "Add a dark mode toggle to settings.\n\nReuse the palette from [Release checklist](#t-release); [Theme spike](#0d4f6b2a-8c1e-4f3a-9b7d-2e5c6a1f8b90) was closed.",
          {
            threadId: "t-plan" as ThreadId,
            title: "Plan the auth refactor",
            depth: 1,
            mode: "steer",
          },
        ),
        assistantMessage(
          "m-k2",
          "Done: the toggle persists to `localStorage` and respects the OS setting. [Plan the auth refactor](#t-plan) can rebase on it.",
        ),
      ];
    default:
      return [];
  }
}

/** Threads that start a scripted turn the first time they're opened. */
export const AUTOPLAY: Record<string, string> = {
  "t-flaky": "Make the retry test deterministic.",
  "t-docs": "Rewrite the README for the new install flow.",
  "t-background":
    "Use the Task tool with subagent_type Explore to list the files in this repo, then reply DONE.",
};

// ---------------------------------------------------------------------------------------------
// Scripts

const RETRY_PATCH = {
  filePath: "/Users/dev/code/api/src/retry.test.ts",
  oldString: "await sleep(100);",
  newString: "await clock.tickAsync(100);",
  originalFile: null,
  userModified: false,
  structuredPatch: [
    {
      oldStart: 12,
      oldLines: 5,
      newStart: 12,
      newLines: 6,
      lines: [
        '   it("retries twice", async () => {',
        "+    const clock = useFakeTimers();",
        "     const op = flaky(2);",
        "     const result = retry(op, { attempts: 3 });",
        "-    await sleep(100);",
        "+    await clock.tickAsync(100);",
        '     expect(await result).toBe("ok");',
      ],
    },
  ],
};

export const flakyScript: Script = (_input, ids) => {
  const m = ids();
  const sub = ids();
  const bashPush = ids();
  const task = ids();
  return [
    status("running", "Thinking…"),
    {
      kind: "plan",
      items: [
        {
          content: "Reproduce the flake",
          status: "inProgress",
          activeForm: "Reproducing the flake",
        },
        { content: "Switch the test to the fake clock", status: "pending" },
        { content: "Push the branch", status: "pending" },
        { content: "Look for sibling tests", status: "pending" },
      ],
    },
    ...start(m, { agent: "claude", model: "opus" }),
    // Live usage only ever grows from what the thread was seeded with. Autoplay stops at the approval
    // below, so this is the reading a spec that opens the thread sees; one below the seed made the
    // meter drop from 31% to 3% a moment after arrival.
    {
      kind: "usage",
      usage: {
        tokens: { inputTokens: 59_100, outputTokens: 2_360, cacheReadTokens: 31_000 },
        contextWindow: 200_000,
        contextTokens: 62_010,
        costUsd: 0.46,
        costEstimated: true,
      },
    },
    ...reasoning(
      m,
      "r1",
      "The retry test sleeps for a real 100 ms and asserts on ordering. Under load the timer fires late, so the fake clock is the right fix.",
    ),
    chunk(m, {
      type: "data-chapter",
      id: "ch-1",
      data: { id: "ch-1", title: "Reproduce the flake" },
    }),
    ...text(m, "t1", "I'll start by reading the test and running it a few times."),
    status("running", "Reading retry.test.ts…"),
    // An e2e spec holds the turn running here, to queue and steer into it, until it releases this.
    gate("flaky-read"),
    ...tool(
      m,
      ids(),
      "Read",
      { file_path: "/Users/dev/code/api/src/retry.test.ts", offset: 1, limit: 40 },
      {
        type: "text",
        file: {
          filePath: "/Users/dev/code/api/src/retry.test.ts",
          content: "…",
          numLines: 40,
          startLine: 1,
          totalLines: 88,
        },
      },
    ),
    status("running", "Running pnpm test retry…"),
    ...tool(
      m,
      ids(),
      "Bash",
      { command: "pnpm test retry --repeat 20", description: "Run the retry test 20 times" },
      {
        stdout:
          " ✓ src/retry.test.ts (3 tests) 1204ms\n × retries twice (flaky: 3/20 failed)\n\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)",
        stderr: "",
        interrupted: false,
      },
      900,
    ),
    chunk(m, { type: "data-chapter", id: "ch-2", data: { id: "ch-2", title: "Fix" } }),
    ...text(m, "t2", "Confirmed: 3 of 20 runs fail. Switching the test to the fake clock."),
    status("running", "Editing retry.test.ts…"),
    ...tool(
      m,
      ids(),
      "Edit",
      {
        file_path: RETRY_PATCH.filePath,
        old_string: RETRY_PATCH.oldString,
        new_string: RETRY_PATCH.newString,
      },
      RETRY_PATCH,
    ),
    ...text(m, "t3", "The test passes 20/20 now. I'd like to push the branch."),
    ...toolCall(
      m,
      bashPush,
      "Bash",
      { command: "git push origin fix/flaky-retry", description: "Push the branch" },
      100,
    ),
    {
      kind: "request",
      request: {
        kind: "approval",
        id: `r-${bashPush}` as RequestId,
        toolUseId: bashPush,
        toolName: "Bash",
        displayName: "Bash",
        input: { command: "git push origin fix/flaky-retry", description: "Push the branch" },
        description: "Push the branch",
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "git push origin fix/flaky-retry" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      },
      onAnswer: (answer) =>
        answer.kind === "approval" && answer.decision === "allow"
          ? [
              status("running", "Pushing…"),
              wait(500),
              toolResult(m, bashPush, {
                stdout:
                  "To github.com:example/api.git\n * [new branch]      fix/flaky-retry -> fix/flaky-retry",
                stderr: "",
                interrupted: false,
              }),
            ]
          : [
              toolError(
                m,
                bashPush,
                `Permission denied${answer.kind === "approval" && answer.message ? `: ${answer.message}` : ""}`,
              ),
            ],
    },
    chunk(m, {
      type: "data-chapter",
      id: "ch-3",
      data: { id: "ch-3", title: "Look for siblings" },
    }),
    status("running", "Exploring other tests…"),
    ...toolCall(
      m,
      task,
      "Task",
      {
        description: "Find other sleep-based tests",
        prompt: "Search the repo for tests that await real timers.",
        subagent_type: "Explore",
      },
      100,
    ),
    // Claude's `task_started`, which the server hangs on the reply until the subagent's own
    // transcript opens. The mock stamps `startedAt` on it, as the adapter does.
    chunk(m, {
      type: "data-subagent-usage",
      id: task,
      data: { toolCallId: task, status: "running", subagentType: "Explore" },
    }),
    ...start(sub, { parentToolUseId: task, agent: "claude", model: "claude-haiku-4-5-20251001" }),
    chunk(sub, {
      type: "data-subagent-usage",
      id: task,
      data: {
        toolCallId: task,
        status: "running",
        totalTokens: 1_480,
        toolUses: 1,
        durationMs: 900,
        subagentType: "Explore",
        lastToolName: "Grep",
      },
    }),
    ...text(sub, "s1", "Searching for `await sleep(` in test files."),
    ...tool(
      sub,
      ids(),
      "Grep",
      { pattern: "await sleep\\(", glob: "**/*.test.ts", output_mode: "files_with_matches" },
      {
        mode: "files_with_matches",
        numFiles: 2,
        filenames: ["src/poll.test.ts", "src/queue.test.ts"],
      },
    ),
    ...text(sub, "s2", "Two more files use real timers: `poll.test.ts` and `queue.test.ts`."),
    ...finish(sub),
    toolResult(m, task, {
      status: "completed",
      agentId: "agent-1",
      content: [{ type: "text", text: "Two more files use real timers." }],
      prompt: "Search the repo for tests that await real timers.",
      totalToolUseCount: 1,
      totalDurationMs: 2300,
      totalTokens: 4120,
    }),
    chunk(m, {
      type: "data-task-chip",
      id: "task-poll",
      data: {
        id: "task-poll" as TaskId,
        title: "Fix the same sleep in poll.test.ts",
        prompt: "Switch src/poll.test.ts to the fake clock, like retry.test.ts.",
        checkout: "new-worktree",
        branch: "fix/poll-flake",
        status: "offered",
      },
    }),
    ...text(
      m,
      "t4",
      "Done. Summary:\n\n- `retry.test.ts` uses `useFakeTimers()`; **20/20** passes\n- Branch pushed\n- Two sibling tests have the same problem; I've offered a follow-up task for one of them.\n\n```ts\nconst clock = useFakeTimers();\nawait clock.tickAsync(100);\n```",
    ),
    ...finish(m),
    {
      kind: "plan",
      items: [
        { content: "Reproduce the flake", status: "completed" },
        { content: "Switch the test to the fake clock", status: "completed" },
        { content: "Push the branch", status: "completed" },
        { content: "Look for sibling tests", status: "completed" },
      ],
    },
    {
      kind: "usage",
      usage: {
        tokens: { inputTokens: 76_604, outputTokens: 3_472, cacheReadTokens: 43_000 },
        contextWindow: 200_000,
        contextTokens: 91_404,
        costUsd: 0.63,
      },
    },
  ];
};

export const questionAnswered = (answer: RequestAnswer, ids: () => string): Step[] => {
  const m = ids();
  const picked =
    answer.kind === "question"
      ? Object.values(answer.answers)
          .map((v) => v.join(", "))
          .join(" · ")
      : "";
  return [
    status("running", "Thinking…"),
    ...start(m),
    ...text(m, "t1", `Got it (${picked}). Wiring up the picker now.`),
    ...finish(m),
  ];
};

export const planAnswered = (answer: RequestAnswer, ids: () => string): Step[] => {
  const m = ids();
  const approved = answer.kind === "plan" && answer.decision === "approve";
  return [
    status("running", "Thinking…"),
    ...start(m),
    ...text(
      m,
      "t1",
      approved
        ? `Plan approved. Starting with step 1 in \`${answer.kind === "plan" ? (answer.mode ?? "acceptEdits") : ""}\` mode.`
        : "Understood, I'll revise the plan.",
    ),
    ...finish(m),
  ];
};

export const docsScript: Script = (_input, ids) => {
  const m = ids();
  const paragraph =
    "Gram runs your coding agents side by side, each in its own worktree, and tells you which ones need you. ";
  return [
    status("running", "Writing README.md…"),
    ...start(m),
    ...text(m, "t1", `# Gram\n\n${paragraph.repeat(6)}`, 90),
    ...finish(m),
  ];
};

/** The default reply to a sent message. */
/** What `show_widget` would draw: theme variables only, so it follows the palette and mode. */
const MOCK_CHART = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="480" height="240">',
  '<rect width="240" height="120" rx="6" fill="var(--surface)" stroke="var(--border)"/>',
  '<text x="12" y="20" font-family="var(--font)" font-size="10" fill="var(--fg)">p95 latency, ms</text>',
  ...[38, 64, 51, 82].map(
    (value, i) =>
      `<rect x="${20 + i * 54}" y="${104 - value}" width="36" height="${value}" rx="3" fill="var(--${i === 3 ? "warning" : "accent"})"/>`,
  ),
  '<line x1="12" y1="104" x2="228" y2="104" stroke="var(--fg-muted)"/>',
  "</svg>",
].join("");

const MOCK_ISSUE = {
  repo: "ANT1OFF/gram",
  labels: ["bug", "web"],
  title: "Terminal output freezes after resizing the split",
  body: [
    "After dragging the split between two panes, the terminal in the right pane stops drawing new output until it is focused again.",
    "",
    "Steps:",
    "1. Open a thread with the terminal panel and run `pnpm dev` in ~/code/api.",
    "2. Split the window (⌘\\) and drag the divider.",
    "3. The right terminal keeps its old frame; clicking it redraws everything at once.",
    "",
    "Expected: the terminal keeps drawing while the split is resized.",
    "",
    "---",
    "",
    "**Diagnostics**",
    "",
    "- Gram 0.6.0",
    "- Darwin 25.0.0 (darwin arm64)",
    "- Agent: claude 2.1.273, model claude-opus-5-5",
    "- Filed from Gram by an agent in a thread",
  ].join("\n"),
};

/** A `report_issue` call and its card, as the server raises it: the issue as it would be posted. */
const reportIssueSteps = (m: string, callId: string): Step[] => [
  ...toolCall(
    m,
    callId,
    "mcp__gram__report_issue",
    { kind: "bug", area: "web", title: MOCK_ISSUE.title, body: "…" },
    100,
  ),
  {
    kind: "request",
    request: {
      kind: "approval",
      id: `r-${callId}` as RequestId,
      toolUseId: callId,
      toolName: "mcp__gram__report_issue",
      displayName: "report_issue",
      input: MOCK_ISSUE,
      description: `File “${MOCK_ISSUE.title}” on ANT1OFF/gram (bug, web)`,
      suggestions: [],
      scopes: ["once"],
    },
    onAnswer: (answer) =>
      answer.kind === "approval" && answer.decision === "allow"
        ? [
            toolResult(m, callId, {
              number: 162,
              url: "https://github.com/ANT1OFF/gram/issues/162",
            }),
            ...text(m, "t2", "Filed https://github.com/ANT1OFF/gram/issues/162."),
          ]
        : [toolError(m, callId, "The user declined report_issue.")],
  },
];

/** A `settings_propose` card as the server raises it: the change set as before → after rows. */
const MOCK_SETTINGS_CHANGE = {
  scope: "workspace",
  workspace: { id: "w-api", name: "[Workspace name]" },
  reason: "You asked for fewer workers at once and a cheaper model for reviews.",
  rows: [
    {
      key: "workspace.maxConcurrentWorkers",
      label: "Max concurrent workers",
      before: "10",
      after: "4",
    },
    {
      key: "workspace.workerModels",
      label: "Worker model claude:haiku",
      before: "claude:haiku · medium — simple tasks, fast and cheap; well-specified work",
      after: "claude:haiku · medium — reviews and simple tasks",
    },
    {
      key: "workspace.workerModels",
      label: "Worker model claude:sonnet",
      before: null,
      after: "claude:sonnet · high — reviews",
    },
    {
      key: "workspace.workerModels",
      label: "Worker model codex:gpt-6.1-sol",
      before: "codex:gpt-6.1-sol · high — reviews, bug hunts, audits, tightly scoped changes",
      after: null,
    },
  ],
};

const settingsChangeSteps = (m: string, callId: string): Step[] => [
  ...toolCall(m, callId, "mcp__gram__settings_propose", { changes: "…" }, 100),
  {
    kind: "request",
    request: {
      kind: "approval",
      id: `r-${callId}` as RequestId,
      toolUseId: callId,
      toolName: "mcp__gram__settings_propose",
      displayName: "Change settings",
      input: MOCK_SETTINGS_CHANGE,
      description: "Change 4 settings in the workspace “[Workspace name]”.",
      suggestions: [],
      scopes: ["once"],
    },
    onAnswer: (answer) =>
      answer.kind === "approval" && answer.decision === "allow"
        ? [toolResult(m, callId, { applied: true }), ...text(m, "t2", "Applied.")]
        : [toolError(m, callId, "The user declined the settings change; nothing changed.")],
  },
];

/** A `workspace_create` card as the server raises it: the projects, then what it will have. */
const MOCK_WORKSPACE_CREATE = {
  action: "create",
  workspace: { name: "[Workspace name]" },
  reason: "The handoff README lists this workspace with these repositories.",
  projects: [
    { root: "/Users/dev/code/api", name: "api", change: "added", home: true },
    { root: "/Users/dev/code/web", name: "web", change: "added", unregistered: true },
  ],
  rows: [
    {
      key: "workspace.autonomy",
      label: "Autonomy",
      before: null,
      after: "Publish: pushes branches and opens PRs, asks before merging",
    },
    { key: "workspace.workerMode", label: "Worker mode", before: null, after: "Auto" },
    {
      key: "workspace.maxConcurrentWorkers",
      label: "Max concurrent workers",
      before: null,
      after: "4",
    },
    {
      key: "workspace.mergeReviewPolicy",
      label: "Merge review policy",
      before: null,
      after: "bot",
    },
    {
      key: "workspace.orchestratorModel",
      label: "Orchestrator model",
      before: null,
      after: "claude:opus · high · standard",
    },
    {
      key: "workspace.workerModels",
      label: "Worker model claude:sonnet",
      before: null,
      after: "claude:sonnet · high — reviews and refactors",
    },
    {
      key: "workspace.workerModels",
      label: "Worker model used when none is named",
      before: null,
      after: "claude:sonnet",
    },
  ],
};

/** A `workspace_update` card as the server raises it: the projects, then before → after. */
const MOCK_WORKSPACE_UPDATE = {
  action: "update",
  workspace: { id: "w-api", name: "[Workspace name]" },
  reason: "You asked to add the web app and let workers edit without asking.",
  projects: [
    { root: "/Users/dev/code/api", name: "api", change: "kept", home: true },
    { root: "/Users/dev/code/docs", name: "docs", change: "removed" },
    { root: "/Users/dev/code/web", name: "web", change: "added", unregistered: true },
  ],
  rows: [
    {
      key: "workspace.autonomy",
      label: "Autonomy",
      before: "Supervised: asks before anything leaves the machine",
      after: "Publish: pushes branches and opens PRs, asks before merging",
    },
    { key: "workspace.workerMode", label: "Worker mode", before: "Ask", after: "Accept edits" },
    {
      key: "workspace.maxConcurrentWorkers",
      label: "Max concurrent workers",
      before: "10",
      after: "4",
    },
  ],
  notes: ["The orchestrator and its workers reopen at the new autonomy once each is idle."],
};

const workspaceSteps = (m: string, callId: string, create: boolean): Step[] => {
  const toolName = create ? "mcp__gram__workspace_create" : "mcp__gram__workspace_update";
  return [
    ...toolCall(m, callId, toolName, { name: "…" }, 100),
    {
      kind: "request",
      request: {
        kind: "approval",
        id: `r-${callId}` as RequestId,
        toolUseId: callId,
        toolName,
        displayName: create ? "Create workspace" : "Change workspace",
        input: create ? MOCK_WORKSPACE_CREATE : MOCK_WORKSPACE_UPDATE,
        description: create
          ? "Create the workspace “[Workspace name]” with 2 projects."
          : "Change 5 things in the workspace “[Workspace name]”.",
        suggestions: [],
        scopes: ["once"],
      },
      onAnswer: (answer) =>
        answer.kind === "approval" && answer.decision === "allow"
          ? [toolResult(m, callId, { applied: true }), ...text(m, "t2", "Done.")]
          : [toolError(m, callId, "The user declined the workspace change; nothing changed.")],
    },
  ];
};

export const echoScript: Script = (input, ids) => {
  const m = ids();
  // A prompt that asks for a chart gets one, so the widget card can be seen without a real agent.
  const chart = /\bchart\b/i.test(input.text);
  // And one that mentions a screenshot reads an image, the way the server reports it: the stored
  // file as a `data-tool-image` part, and a `Read` output with no bytes in it.
  const screenshot = /\bscreenshot\b/i.test(input.text);
  const readId = screenshot ? ids() : "";
  // And one that asks to report an issue files one, card and all.
  const issueId = /\breport\b.*\bissue\b/i.test(input.text) ? ids() : "";
  // And one that asks to change settings proposes a change, card and all.
  const settingsId = /\bchange\b.*\bsettings\b/i.test(input.text) ? ids() : "";
  // And one that asks to create or change a workspace proposes it, card and all.
  const workspaceMatch = /\b(create|change)\b.*\bworkspace\b/i.exec(input.text);
  const workspaceId = workspaceMatch === null ? "" : ids();
  const { base64: _, ...stored } = MOCK_TOOL_IMAGE;
  return [
    status("running", "Thinking…"),
    ...start(m),
    wait(300),
    ...(screenshot
      ? [
          ...toolCall(m, readId, "Read", { file_path: "/Users/dev/code/api/docs/logo.png" }, 100),
          chunk(m, {
            type: "data-tool-image",
            id: `${readId}:logo`,
            data: { toolCallId: readId, ...stored },
          }),
          toolResult(m, readId, { type: "image", file: { type: "image/png", originalSize: 440 } }),
        ]
      : []),
    ...text(m, "t1", `On it: “${input.text}”. (Mock reply.)`),
    ...(issueId === "" ? [] : reportIssueSteps(m, issueId)),
    ...(settingsId === "" ? [] : settingsChangeSteps(m, settingsId)),
    ...(workspaceId === ""
      ? []
      : workspaceSteps(m, workspaceId, workspaceMatch?.[1]?.toLowerCase() === "create")),
    ...(chart
      ? [
          chunk(m, {
            type: "data-widget",
            id: "w-latency",
            data: { id: "w-latency", title: "p95 latency by region", svg: MOCK_CHART },
          }),
        ]
      : []),
    ...finish(m),
  ];
};

/**
 * An orchestrator's reply: the echo, held at gate `orchestrator-turn` once it is running, so a spec
 * can see the turn under way and brief a worker from it (`simulateBrief`) before it ends.
 */
export const orchestratorScript: Script = (input, ids) => {
  const [running, ...rest] = echoScript(input, ids);
  return [...(running === undefined ? [] : [running]), gate("orchestrator-turn"), ...rest];
};

/** The model a `/model <id>` line asks for, as Claude's own slash command reads it. */
export const modelCommand = (input: string): string | undefined =>
  /^\/model\s+(\S+)\s*$/.exec(input)?.[1];

/** Claude's reply to a `/model`: a local command's output, with no model turn behind it. */
export const modelSwitchedScript = (model: string, ids: () => string): Step[] => {
  const m = ids();
  return [
    ...start(m),
    ...text(m, "t1", `Set model to \`${model}\` for this session only`),
    ...finish(m),
  ];
};

/** Whether a line is Claude's `/compact`, which the mock answers the way the agent does. */
export const isCompactCommand = (input: string): boolean => /^\/compact(\s|$)/.test(input.trim());

const MOCK_COMPACT_SUMMARY = [
  "1. Primary Request and Intent:",
  "   - Make the retry test deterministic: it sleeps a real 100 ms and fails under load.",
  "",
  "2. Key Technical Concepts:",
  "   - Fake timers (`useFakeTimers`, `clock.tickAsync`) in place of `sleep`.",
  "",
  "3. Files and Code Sections:",
  "   - `src/retry.test.ts`: the `retries twice` case now advances the fake clock.",
  "",
  "4. Pending Tasks:",
  "   - Push the branch and look for sibling tests with the same sleep.",
].join("\n");

/**
 * Claude's reply to `/compact`: no model turn, only the marker where the conversation was compacted,
 * and the meter down to what's left of the context.
 */
export const compactScript = (usage: UsageSummary | undefined, ids: () => string): Step[] => {
  const m = ids();
  const preTokens = usage?.contextTokens ?? 182_000;
  const postTokens = Math.round(preTokens * 0.13);
  return [
    {
      kind: "status",
      status: "running",
      detail: "Compacting context",
      compaction: { startedAt: Date.now(), trigger: "manual", preTokens },
    },
    gate("compaction"),
    wait(600),
    ...start(m),
    chunk(m, {
      type: "data-compaction",
      id: `compaction:${m}`,
      data: {
        trigger: "manual",
        preTokens,
        postTokens,
        at: Date.now(),
        summary: MOCK_COMPACT_SUMMARY,
      },
    }),
    status("running"),
    // A `/compact` ends with the usage report of any turn, which the meter reads.
    {
      kind: "usage",
      usage: {
        tokens: usage?.tokens ?? { inputTokens: 0, outputTokens: 0 },
        contextWindow: usage?.contextWindow ?? 200_000,
        contextTokens: postTokens,
        ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      },
    },
    ...finish(m),
  ];
};

const SPIKE_FILES = [
  "CLAUDE.md",
  "README.md",
  "notes.md",
  "plan.txt",
  "beta.txt",
  "hi.txt",
  "index.ts",
];

const FILE_TREE_REPORT = [
  "Here's the complete file tree structure for the repository:",
  "",
  "```",
  "fixture-project/",
  ...SPIKE_FILES.map((file, i) => `${i === SPIKE_FILES.length - 1 ? "└──" : "├──"} ${file}`),
  "```",
  "",
  "**Summary:** 7 project files: documentation (Markdown, text), a TypeScript file, and standard git infrastructure.",
].join("\n");

/**
 * Replays an invented Explore subagent with the Claude Code 2.1.273 protocol shape in
 * `packages/agents/fixtures/claude/p12-background-subagent.jsonl`: the Agent card gets a launch result at
 * once, the turn ends while the subagent works on, and the agent answers once it reports back.
 */
export const backgroundSubagentScript: Script = (_input, ids) => {
  const m = ids();
  const sub = ids();
  const reply = ids();
  const explore = "toolu_fixture_0023";
  const task = {
    description: "List all files in the repository",
    subagent_type: "Explore",
    prompt:
      "List all files in this repository. Use glob patterns to find and report the complete file tree structure.",
  };
  return [
    status("running", "Thinking…"),
    ...start(m, { agent: "claude", model: "haiku" }),
    status("running", "Starting a subagent"),
    ...toolCall(m, explore, "Agent", task, 200),
    chunk(m, {
      type: "data-subagent-usage",
      id: explore,
      data: { toolCallId: explore, status: "running", subagentType: "Explore" },
    }),
    toolResult(m, explore, {
      status: "async_launched",
      agentId: "fixture-explore",
      description: task.description,
      prompt: task.prompt,
      outputFile: "/synthetic/tasks/fixture-explore.output",
    }),
    background({
      taskId: "fixture-explore",
      kind: "subagent",
      description: task.description,
      subagentType: "Explore",
      toolCallId: explore,
    }),
    ...start(sub, {
      parentToolUseId: explore,
      agent: "claude",
      model: "claude-haiku-4-5-20251001",
    }),
    ...text(m, "t1", "Background file scan started. The Explore agent will report its findings."),
    ...finish(m),
    // The turn is over, but the subagent works on.
    status("idle", "Explore: Thinking"),
    wait(1000),
    ...text(sub, "s1", "I will list the fixture files using glob patterns."),
    status("idle", "Explore: Finding **/*"),
    chunk(sub, {
      type: "data-subagent-usage",
      id: explore,
      data: {
        toolCallId: explore,
        status: "running",
        totalTokens: 2_140,
        toolUses: 1,
        durationMs: 1_400,
        subagentType: "Explore",
        lastToolName: "Glob",
      },
    }),
    ...tool(
      sub,
      "toolu_glob",
      "Glob",
      { pattern: "**/*" },
      { filenames: SPIKE_FILES, durationMs: 25, numFiles: SPIKE_FILES.length, truncated: false },
      1500,
    ),
    status("idle", "Explore: Writing a reply"),
    wait(1000),
    ...text(sub, "s2", FILE_TREE_REPORT, 10),
    // An e2e spec holds here, idle with the subagent still working, until it releases the gate; the
    // report is already written, so the subagent finishes in one step, however loaded the machine.
    gate("subagent-report"),
    chunk(sub, {
      type: "data-subagent-usage",
      id: explore,
      data: {
        toolCallId: explore,
        status: "completed",
        totalTokens: 5_380,
        toolUses: 2,
        durationMs: 8_200,
        subagentType: "Explore",
      },
    }),
    ...finish(sub),
    background(),
    // The report comes back as a turn the agent starts on its own.
    status("running", "Thinking…"),
    ...start(reply, { agent: "claude", model: "haiku", initiator: "agent" }),
    wait(400),
    ...text(reply, "t2", "DONE"),
    ...finish(reply),
  ];
};
