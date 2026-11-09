import {
  orchestrationMode,
  type DiffFile,
  type DigestChange,
  type DigestReport,
  type GitState,
  type GramUIMessage,
  type OrchestrationDigest,
  type PendingRequest,
  type ProjectId,
  type RequestId,
  type Thread,
  type ThreadId,
  type TurnId,
  type WorkerReport,
  type WorkspaceId,
} from "@gram/contracts";

import { seedMergedPr } from "./mock-git";
import type { MockScenes } from "./mock-orchestration";

// The realistic scenario: Gram on an ordinary working morning, modelled on a real window rather
// than on a stress test. Four orchestrators, five live workers with plain status lines and one PR
// waiting on checks, a long calm orchestrator transcript (prose with bold lead-ins, PR links, a
// folded tool row, digest lines and merged rows, "Since you left"), merged work in Done under each
// workspace, and a single ask. The worker "Search in Settings" has a real-looking transcript: a
// reply, three commands folded into one row, edits with their diff, and a turn that changed files.
// Every name is invented; nothing is any user's own.

const MINUTE = 60_000;

/** What the realistic scenario made, for a shot or a spec to navigate by. */
/** The release-notes worker's merged PR: a new page, the changelog, and the shortcuts list. */
const RELEASE_NOTES_FILES: readonly DiffFile[] = [
  {
    path: "docs/releases/0.9.md",
    status: "added",
    additions: 4,
    deletions: 0,
    patch: [
      "@@ -0,0 +1,4 @@",
      "+# Gram 0.9",
      "+",
      "+- **Undo a turn:** restores the files a turn edited, unless a later turn touched them.",
      "+- **Empty states:** the Board, History and Search say what to do next.",
    ].join("\n"),
    binary: false,
    tooLarge: false,
  },
  {
    path: "CHANGELOG.md",
    status: "modified",
    additions: 4,
    deletions: 1,
    patch: [
      "@@ -1,4 +1,7 @@",
      " # Changelog",
      " ",
      "-## Unreleased",
      "+## 0.9",
      "+",
      "+See [the release notes](docs/releases/0.9.md).",
      "+",
      " ## 0.8",
    ].join("\n"),
    binary: false,
    tooLarge: false,
  },
  {
    path: "docs/shortcuts.md",
    status: "modified",
    additions: 2,
    deletions: 0,
    patch: [
      "@@ -12,3 +12,5 @@",
      " | Open History | ⌘⇧H |",
      " | Search | ⌘K |",
      "+| Focus review | ⌘⌥F |",
      "+| Next change in the diff | n |",
      " | Settings | ⌘, |",
    ].join("\n"),
    binary: false,
    tooLarge: false,
  },
];

export interface MockRealisticSimulation {
  /** The "Gram" workspace, whose orchestrator has the long transcript. */
  readonly workspaceId: WorkspaceId;
  readonly orchestratorThreadId: ThreadId;
  /** "Search in Settings": idle, its PR #142 waiting on checks, with the full worker transcript. */
  readonly searchWorker: ThreadId;
  /** The live workers, running, each with what it is doing as the server's activity line says. */
  readonly running: readonly { readonly threadId: ThreadId; readonly activity: string }[];
  /** The one worker that asks the user something, in "billing-api". */
  readonly asking: ThreadId;
  readonly askingWorkspaceId: WorkspaceId;
  /** Every workspace, in the order the sidebar lists them. */
  readonly workspaceIds: readonly WorkspaceId[];
}

/** What the scenario needs beside the orchestration mock's own state. */
export interface MockRealisticDeps {
  /** The projects each workspace works in, made by the caller (they are folders the mock knows). */
  readonly projects: {
    readonly gram: ProjectId;
    readonly docs: ProjectId;
    readonly api: ProjectId;
    readonly web: ProjectId;
    readonly infra: ProjectId;
  };
  /** Files a finished turn changed, for its "N files changed" card and Undo. */
  readonly turnFiles: (threadId: ThreadId, turnId: TurnId, files: readonly DiffFile[]) => void;
}

type Part = GramUIMessage["parts"][number];

const text = (value: string): Part => ({
  type: "text",
  text: value,
  state: "done",
});

let toolSeq = 0;
const tool = (name: string, input: unknown, output: unknown = ""): Part =>
  ({
    type: `tool-${name}`,
    toolCallId: `toolu_real_${++toolSeq}`,
    state: "output-available",
    input,
    output,
  }) as Part;

const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

/** A worker's merge, as a digest's change says it. */
const mergedChange = (worker: Thread, feature: string): DigestChange => ({
  threadId: worker.id,
  feature,
  title: worker.title,
  from: "readyToMerge",
  to: "merged",
});

export async function simulateRealistic(
  scenes: MockScenes,
  deps: MockRealisticDeps,
): Promise<MockRealisticSimulation> {
  const { host, create, fillSlot, find, project, reports, buildLedger, digestMessage } = scenes;
  const settings = await host.settings();
  const now = Date.now();
  const at = (minutesAgo: number) => now - minutesAgo * MINUTE;
  const { gram, docs, api, web, infra } = deps.projects;

  // Each orchestrator's last activity is fixed, Gram's the newest, so the launch (which opens the
  // newest orchestrator) always lands on Gram, never on one of the idle workspaces.
  const workspace = async (
    name: string,
    projectIds: readonly [ProjectId, ...ProjectId[]],
    activeMinutesAgo: number,
  ) => {
    const state = await create({
      name,
      projectIds,
      homeProjectId: projectIds[0],
    });
    const filled = await fillSlot(state, settings);
    const orchestrator: Thread = { ...filled, lastActivityAt: at(activeMinutesAgo) };
    host.replace(orchestrator);
    host.setUsage(orchestrator.id, {
      tokens: { inputTokens: 0, outputTokens: 0 },
      contextWindow: 200_000,
      contextTokens: 71_000,
    });
    return { workspaceId: state.workspace.id, orchestrator };
  };

  const gramSpace = await workspace("Gram", [gram, docs], 7);
  const billing = await workspace("billing-api", [api], 45);
  const webSpace = await workspace("web", [web], 6 * 60);
  const infraSpace = await workspace("infra", [infra], 9 * 60);

  const spawn = async (
    space: { workspaceId: WorkspaceId; orchestrator: Thread },
    projectId: ProjectId,
    feature: string,
    title: string,
    createdMinutesAgo: number,
  ) => {
    const created = await host.createThread({
      projectRoot: project(projectId).root,
      title,
      mode: orchestrationMode(settings),
      branch: `feat/${feature}`,
    });
    const worker: Thread = {
      ...created,
      workspaceId: space.workspaceId,
      spawnedBy: { threadId: space.orchestrator.id, feature },
      createdAt: at(createdMinutesAgo),
      lastActivityAt: at(Math.max(createdMinutesAgo - 20, 1)),
    };
    host.replace(worker);
    return worker;
  };

  const gitOf = (
    worker: Thread,
    repo: string,
    pr:
      | {
          number: number;
          state: "OPEN" | "MERGED";
          checks: "pending" | "passing";
        }
      | undefined,
    changedFiles = 0,
  ): GitState => ({
    repo: true,
    branch: worker.checkout.branch!,
    worktree: true,
    head: `${pr?.number ?? 7}e4c1a9`.padEnd(40, "0"),
    changesToken: `mock-real-${worker.id}`,
    changedFiles,
    base: "origin/main",
    behindBase: pr?.state === "MERGED" ? 2 : 0,
    aheadBase: pr?.state === "MERGED" ? 0 : 3,
    conflicts: false,
    upstream: "synced",
    origin: repo,
    ...(pr === undefined
      ? {}
      : {
          pr: {
            number: pr.number,
            state: pr.state,
            url: prUrl(repo, pr.number),
            title: worker.title,
            isDraft: false,
            checks: pr.checks,
            headMatches: true,
            aheadOfPr: false,
            baseRef: "main",
            headRef: worker.checkout.branch!,
          },
        }),
  });

  const merged = (worker: Thread, repo: string, number: number, minutesAgo: number) => {
    host.setGit(worker.id, gitOf(worker, repo, { number, state: "MERGED", checks: "passing" }));
    host.replace({
      ...worker,
      completedAt: at(minutesAgo),
      completedReason: "prMerged",
      lastActivityAt: at(minutesAgo),
    });
  };

  const report = (
    worker: Thread,
    state: WorkerReport["state"],
    summary: string,
    minutesAgo: number,
    pr?: string,
  ) => {
    const filed: WorkerReport = {
      threadId: worker.id,
      state,
      summary,
      at: at(minutesAgo),
      ...(pr === undefined ? {} : { prUrl: pr }),
    };
    reports.set(worker.id, filed);
    return filed;
  };

  const cost = (threadId: ThreadId, costUsd: number) =>
    host.setUsage(threadId, {
      tokens: { inputTokens: 0, outputTokens: 0 },
      costUsd,
    });

  // --- Gram: four live workers, six merged today. ---------------------------------------------
  const gramRepo = "example/gram";
  const comments = await spawn(
    gramSpace,
    gram,
    "diff-comments",
    "Inline comments in the diff",
    135,
  );
  const shortcuts = await spawn(gramSpace, gram, "shortcut-sheet", "Keyboard shortcut sheet", 100);
  const coldStart = await spawn(gramSpace, gram, "cold-start", "Faster cold start", 134);
  const search = await spawn(gramSpace, gram, "settings-search", "Search in Settings", 136);

  const undo = await spawn(gramSpace, gram, "undo-turn", "Undo a turn's file edits", 300);
  const empty = await spawn(gramSpace, gram, "empty-states", "Clearer empty states", 280);
  const hitAreas = await spawn(gramSpace, gram, "hit-areas", "Bigger sidebar hit areas", 240);
  const notes = await spawn(gramSpace, docs, "release-notes", "Release notes for 0.9", 200);
  const uploads = await spawn(gramSpace, gram, "upload-retry", "Retry failed uploads", 160);
  const sort = await spawn(gramSpace, gram, "history-sort", "Stable sort in History", 150);

  merged(undo, gramRepo, 136, 121);
  merged(empty, gramRepo, 137, 119);
  merged(hitAreas, gramRepo, 138, 41);
  merged(notes, "example/docs", 61, 40);
  // Its worktree is gone, so its outcome lists the PR's files.
  seedMergedPr(notes.id, {
    number: 61,
    repo: "example/docs",
    title: "Release notes for 0.9",
    branch: notes.checkout.branch!,
    files: RELEASE_NOTES_FILES,
  });
  merged(uploads, gramRepo, 140, 9);
  merged(sort, gramRepo, 141, 8);
  report(
    undo,
    "done",
    "Undo restores a turn's files; refuses when a later turn touched them.",
    125,
  );
  report(empty, "done", "Empty Board, History and Search now say what to do next.", 122);
  report(hitAreas, "done", "Sidebar rows and icons have 28 px hit areas, with tooltips.", 45);
  report(notes, "done", "0.9 notes cover undo, empty states and the new shortcuts.", 44);
  report(
    uploads,
    "done",
    "Uploads retry three times with backoff; a toast offers Retry after.",
    12,
  );
  report(sort, "done", "History sorts by finish time, ties by title, so rows stop jumping.", 11);

  host.setStatus(comments.id, "running", "Running tests");
  host.setStatus(shortcuts.id, "running", "Running a command");
  host.setStatus(coldStart.id, "running", "Running a background shell");
  for (const [worker, usd] of [
    [comments, 3.4],
    [shortcuts, 1.2],
    [coldStart, 2.7],
    [search, 2.1],
  ] as const) {
    cost(worker.id, usd);
    host.setGit(worker.id, gitOf(worker, gramRepo, undefined, worker === search ? 0 : 4));
  }
  report(comments, "progress", "Comments anchor to diff lines; writing the tests for resolve.", 18);
  report(coldStart, "progress", "Settings read moved off first paint; measuring again.", 25);
  host.setGit(
    search.id,
    gitOf(search, gramRepo, { number: 142, state: "OPEN", checks: "pending" }),
  );
  host.replace({
    ...search,
    lastActivityAt: at(14),
    boundPr: { repo: gramRepo, number: 142, monitor: true },
  });
  report(search, "progress", "Opened #142; waiting on checks.", 14, prUrl(gramRepo, 142));
  seedSearchTranscript(host, search.id, at, deps);

  // --- billing-api: one worker that asks, two merged. -----------------------------------------
  const apiRepo = "example/billing-api";
  const refunds = await spawn(billing, api, "refund-webhooks", "Idempotent refund webhooks", 90);
  const footer = await spawn(billing, api, "invoice-footer", "Invoice PDF footer", 260);
  const rounding = await spawn(
    billing,
    api,
    "report-rounding",
    "Currency rounding in reports",
    220,
  );
  merged(footer, apiRepo, 312, 102);
  merged(rounding, apiRepo, 315, 66);
  cost(refunds.id, 1.6);
  host.setGit(refunds.id, gitOf(refunds, apiRepo, undefined, 3));
  report(refunds, "question", "How long should a refund webhook keep retrying?", 6);
  const question: PendingRequest = {
    kind: "question",
    id: `r-real-${refunds.id}` as RequestId,
    toolUseId: `toolu_real_question_${refunds.id}`,
    questions: [
      {
        question:
          "A refund webhook that keeps failing: retry for 24 hours, or 72 hours like charges do?",
        header: "Retry window",
        multiSelect: false,
        options: [
          {
            label: "72 hours",
            description: "Same as charge webhooks; one policy to explain.",
          },
          {
            label: "24 hours",
            description: "Refunds reach support sooner when a shop is down.",
          },
        ],
      },
    ],
  };
  scenes.askedAt.set(question.id, at(6));
  host.ask(refunds.id, question, () => {
    scenes.askedAt.delete(question.id);
    host.setStatus(refunds.id, "running", "Running tests");
    host.emit({
      type: "orchestration.changed",
      workspaceId: billing.workspaceId,
    });
  });

  // --- web and infra: at rest, with something merged earlier today. ----------------------------
  const checkout = await spawn(webSpace, web, "checkout-states", "Checkout button states", 330);
  merged(checkout, "example/web", 884, 150);
  const certs = await spawn(infraSpace, infra, "staging-certs", "Rotate staging certificates", 400);
  merged(certs, "example/infra", 57, 190);

  // --- The Gram orchestrator's morning, oldest first. ------------------------------------------
  const orchestratorId = gramSpace.orchestrator.id;
  let generation = 780;
  const putAt = (message: GramUIMessage, minutesAgo: number) =>
    host.putMessage(orchestratorId, {
      ...message,
      metadata: { ...message.metadata, createdAt: at(minutesAgo) },
    });
  const say = (minutesAgo: number, ...parts: Part[]) =>
    putAt(
      {
        id: host.ids(),
        role: "assistant",
        metadata: { createdAt: at(minutesAgo), agent: "claude", model: "opus" },
        parts: [{ type: "step-start" }, ...parts],
      },
      minutesAgo,
    );
  const ledgerNow = () => buildLedger(find(gramSpace.workspaceId));
  const digest = (
    minutesAgo: number,
    changes: readonly DigestChange[],
    filed: readonly (WorkerReport & { title: string; feature: string })[],
  ) => {
    const ledger = ledgerNow();
    const facts: OrchestrationDigest = {
      kind: "orchestration",
      variant: "digest",
      generation: ++generation,
      workspaceId: gramSpace.workspaceId,
      workspaceName: "Gram",
      reasons: filed.length > 0 ? ["report"] : ["wake: merge"],
      changes,
      reports: filed as readonly DigestReport[],
      features: ledger.features,
      ...(ledger.groups === undefined ? {} : { groups: ledger.groups }),
      budget: ledger.budget,
      notes: [],
    };
    putAt(digestMessage(facts), minutesAgo);
  };
  const filed = (worker: Thread, feature: string) => ({
    ...reports.get(worker.id)!,
    title: worker.title,
    feature,
  });

  putAt(
    {
      id: host.ids(),
      role: "user",
      metadata: { createdAt: at(140) },
      parts: [
        {
          type: "text",
          text: "Morning. Today: search in Settings, inline comments in the diff, and cold start under a second. Keep main green and merge whatever passes review.",
        },
      ],
    },
    140,
  );
  say(
    139,
    text(
      "**Plan for today.** Four workers in `gram`, one per feature:\n\n- **settings-search**: a filter box over every Settings page.\n- **diff-comments**: comments anchored to diff lines, resolved in place.\n- **cold-start**: profile the launch first, then fix the biggest cost.\n- **shortcut-sheet**: one sheet that lists every shortcut, opened with ⌘/.\n\nYesterday's undo and empty-state PRs are green and only need the merge. I'll merge each PR once its checks and the review bot pass.",
    ),
    tool("mcp__gram__spawn_worker", {
      feature: "settings-search",
      title: "Search in Settings",
      project: "gram",
    }),
    tool("mcp__gram__spawn_worker", {
      feature: "diff-comments",
      title: "Inline comments in the diff",
      project: "gram",
    }),
    tool("mcp__gram__spawn_worker", {
      feature: "cold-start",
      title: "Faster cold start",
      project: "gram",
    }),
  );
  digest(
    118,
    [mergedChange(undo, "undo-turn"), mergedChange(empty, "empty-states")],
    [filed(undo, "undo-turn"), filed(empty, "empty-states")],
  );
  say(
    117,
    text(
      `**[#136](${prUrl(gramRepo, 136)}) and [#137](${prUrl(gramRepo, 137)}) merged.** Undo is on main, and Board, History and Search say what to do when they are empty. Nothing is needed from you.`,
    ),
  );
  digest(95, [], [filed(coldStart, "cold-start")]);
  say(
    94,
    text(
      "**Cold start:** the worker profiled a launch at 1.6 s. Most of it is the settings read and the font load, both on the first paint. It is moving the settings read behind the first frame and preloading the font, then it measures again.",
    ),
  );
  // A memory change among the calls, as an orchestrator makes one between checks.
  const decisions = "# Decisions\n\n- One worker per feature.\n";
  const rule = "- Merge each PR once its checks and the review bot pass.";
  say(
    70,
    tool("Bash", { command: "gh pr checks 142 --repo example/gram" }),
    tool("mcp__gram__pr_status", { pr: 142 }),
    tool("mcp__gram__memory_append", { path: "decisions.md", text: rule }),
    {
      type: "data-memory-write",
      id: host.ids(),
      data: {
        path: "decisions.md",
        action: "write",
        before: decisions,
        after: `${decisions}${rule}\n`,
        bytes: decisions.length + rule.length + 1,
      },
    },
    tool("mcp__gram__pr_review_threads", { pr: 142 }),
    tool("mcp__gram__list_threads", {}),
  );
  say(
    69,
    text(
      `**Search in Settings** is up as [#142](${prUrl(gramRepo, 142)}). The review bot left two nits, an unused import and a missing empty state; the worker fixed both and pushed. Checks are running again on the new head.`,
    ),
  );
  putAt(
    {
      id: host.ids(),
      role: "user",
      metadata: { createdAt: at(52) },
      parts: [
        {
          type: "text",
          text: "Add the shortcut sheet too. Same rules.",
        },
      ],
    },
    52,
  );
  say(
    51,
    text(
      "Started **shortcut-sheet** in `gram`. It reads the shortcuts from the keymap, so the sheet can't drift from what the keys do.",
    ),
    tool("mcp__gram__spawn_worker", {
      feature: "shortcut-sheet",
      title: "Keyboard shortcut sheet",
      project: "gram",
    }),
  );
  digest(
    41,
    [mergedChange(hitAreas, "hit-areas"), mergedChange(notes, "release-notes")],
    [filed(hitAreas, "hit-areas")],
  );
  say(
    40,
    text("All green on #138. Release the hold."),
    tool("mcp__gram__merge_when_ready", { pr: 138 }, "merged"),
    text(
      `Nothing is needed from you. [#138](${prUrl(gramRepo, 138)}) cleared every check on its final head 4be1c09:\n\n**Review:** the review bot said GO.\n\n**Tests:** 2,184 passed, 0 failed.\n\n**Lint and types:** clean.\n\nThe 0.9 release notes merged beside it, so the docs site picks them up on its next build.`,
    ),
  );
  // The user last looked twelve minutes ago, so the last digest is "Since you left".
  const current = host.threads().find((thread) => thread.id === orchestratorId)!;
  host.replace({ ...current, lastViewedAt: at(12), lastActivityAt: at(7) });
  digest(
    8,
    [mergedChange(uploads, "upload-retry"), mergedChange(sort, "history-sort")],
    [filed(uploads, "upload-retry")],
  );
  say(
    7,
    text(
      `**[#140](${prUrl(gramRepo, 140)}) and [#141](${prUrl(gramRepo, 141)}) merged.** Failed uploads retry on their own now, and History stops reordering rows that finish together.\n\nThree workers are still going: diff comments is running its tests, the shortcut sheet is building, and cold start is measuring again in the background. #142 waits on checks; I'll merge it when they pass.`,
    ),
  );

  // --- The quieter orchestrators each have a short exchange. -----------------------------------
  const brief = (space: { orchestrator: Thread }, minutesAgo: number, said: string) =>
    host.putMessage(space.orchestrator.id, {
      id: host.ids(),
      role: "assistant",
      metadata: { createdAt: at(minutesAgo), agent: "claude", model: "opus" },
      parts: [{ type: "step-start" }, text(said)],
    });
  const asked = (space: { orchestrator: Thread }, minutesAgo: number, said: string) =>
    host.putMessage(space.orchestrator.id, {
      id: host.ids(),
      role: "user",
      metadata: { createdAt: at(minutesAgo) },
      parts: [{ type: "text", text: said }],
    });
  asked(
    billing,
    95,
    "Refund webhooks fire twice when the shop retries. Make them idempotent, and fix the rounding in the monthly report while you're there.",
  );
  brief(
    billing,
    94,
    "Two workers in `billing-api`: **refund-webhooks** keys each refund event by its id so a retry is a no-op, and **report-rounding** rounds per line in the shop's currency before summing.",
  );
  brief(
    billing,
    65,
    `**[#312](${prUrl(apiRepo, 312)}) and [#315](${prUrl(apiRepo, 315)}) merged.** The invoice footer shows the VAT number, and monthly totals match the line items to the cent.`,
  );
  brief(
    billing,
    6,
    "**Refund webhooks** asks one thing before it writes the retry: 24 or 72 hours. I'd keep 72, like charges, unless support wants refunds sooner.",
  );
  brief(
    webSpace,
    150,
    `**[#884](${prUrl("example/web", 884)}) merged.** Nothing is running here now.`,
  );
  brief(
    infraSpace,
    190,
    `**[#57](${prUrl("example/infra", 57)}) merged.** Staging serves the new certificates; they renew on their own from now on.`,
  );

  // Memory and Dreams have something to show for the main workspace.
  await host.seedMemory(gramSpace.workspaceId, [gram, docs]);

  for (const space of [gramSpace, billing, webSpace, infraSpace]) {
    host.emit({
      type: "orchestration.changed",
      workspaceId: space.workspaceId,
    });
  }
  return {
    workspaceId: gramSpace.workspaceId,
    orchestratorThreadId: orchestratorId,
    searchWorker: search.id,
    running: [
      { threadId: comments.id, activity: "Running bun run test apps/web/src/review" },
      { threadId: shortcuts.id, activity: "Running bun run gen:keymap" },
      { threadId: coldStart.id, activity: "Editing apps/web/src/boot.ts" },
    ],
    asking: refunds.id,
    askingWorkspaceId: billing.workspaceId,
    workspaceIds: [
      gramSpace.workspaceId,
      billing.workspaceId,
      webSpace.workspaceId,
      infraSpace.workspaceId,
    ],
  };
}

/** The search worker's two turns: the feature with its edits and tests, then the PR. */
function seedSearchTranscript(
  host: MockScenes["host"],
  threadId: ThreadId,
  at: (minutesAgo: number) => number,
  deps: MockRealisticDeps,
) {
  const firstTurn = `turn-real-search-1` as TurnId;
  const secondTurn = `turn-real-search-2` as TurnId;
  const message = (minutesAgo: number, role: "user" | "assistant", parts: Part[], turn?: TurnId) =>
    host.putMessage(threadId, {
      id: host.ids(),
      role,
      metadata: {
        createdAt: at(minutesAgo),
        ...(role === "assistant" ? { agent: "claude" as const, model: "opus" } : {}),
        ...(turn === undefined ? {} : { turnId: turn }),
      },
      parts: role === "user" ? parts : [{ type: "step-start" }, ...parts],
    } as GramUIMessage);

  message(136, "user", [
    {
      type: "text",
      text: "Add a search box at the top of Settings that filters pages and rows as you type. Match labels and descriptions, keep focus in the box, and say so when nothing matches. Open a PR when the tests pass.",
    },
  ]);
  message(
    122,
    "assistant",
    [
      text("I'll start with how Settings lists its pages, so the filter reads one list."),
      tool(
        "Bash",
        { command: 'rg -n "SettingsPage" apps/web/src/settings --type ts' },
        "apps/web/src/settings/pages.ts:12:export const SETTINGS_PAGES: SettingsPage[] = [",
      ),
      tool(
        "Bash",
        { command: "sed -n 1,60p apps/web/src/settings/pages.ts" },
        "export const SETTINGS_PAGES …",
      ),
      tool(
        "Bash",
        { command: "bun run test apps/web/src/settings" },
        "Test Files  9 passed (9)\n     Tests  41 passed (41)",
      ),
      text(
        "**Found it.** Every page registers its rows in `pages.ts` with a label and a description, so search can filter that list and the pages render what is left.",
      ),
      tool("Write", {
        file_path: "apps/web/src/settings/settings-search.ts",
        content: [
          "/** The pages and rows whose label or description holds every word of `query`. */",
          "export function filterPages(pages: readonly SettingsPage[], query: string) {",
          "  const words = query.toLowerCase().split(/\\s+/).filter(Boolean);",
          "  if (words.length === 0) return pages;",
          "  const hit = (row: SettingsRow) =>",
          "    words.every((word) => `${row.label} ${row.description}`.toLowerCase().includes(word));",
          "  return pages",
          "    .map((page) => ({ ...page, rows: page.rows.filter(hit) }))",
          "    .filter((page) => page.rows.length > 0);",
          "}",
        ].join("\n"),
      }),
      tool("Edit", {
        file_path: "apps/web/src/settings/settings-nav.tsx",
        old_string: [
          "  return (",
          '    <nav aria-label="Settings">',
          "      {SETTINGS_PAGES.map((page) => (",
        ].join("\n"),
        new_string: [
          '  const [query, setQuery] = useState("");',
          "  const pages = filterPages(SETTINGS_PAGES, query);",
          "  return (",
          '    <nav aria-label="Settings">',
          "      <SearchField value={query} onChange={setQuery} autoFocus />",
          "      {pages.length === 0 && <EmptyResult query={query} />}",
          "      {pages.map((page) => (",
        ].join("\n"),
      }),
      tool(
        "Bash",
        { command: "bun run test apps/web/src/settings" },
        "Test Files  10 passed (10)\n     Tests  48 passed (48)",
      ),
      text(
        "**Done.** Settings has a search box at the top that filters pages and rows as you type.\n\n- **`settings-search.ts`**: `filterPages` matches every word against a row's label and description.\n- **`settings-nav.tsx`**: the box keeps focus while the list narrows, and says so when nothing matches.\n- **`settings-search.test.ts`**: seven cases, including two words across label and description.\n\n**Tests:** 48 passed, 0 failed.",
      ),
    ],
    firstTurn,
  );
  message(72, "user", [{ type: "text", text: "Looks right. Open the PR." }]);
  message(
    70,
    "assistant",
    [
      tool("Bash", { command: "git push -u origin feat/settings-search" }),
      tool("Bash", {
        command: 'gh pr create --title "feat: search in Settings" --body-file pr.md',
      }),
      text(
        `Opened [#142](${prUrl("example/gram", 142)}). The review bot left two nits, an unused import and a missing empty state; both are fixed and pushed. Waiting on checks now.`,
      ),
    ],
    secondTurn,
  );

  deps.turnFiles(threadId, firstTurn, SEARCH_FILES);
}

const SEARCH_FILES: readonly DiffFile[] = [
  {
    path: "apps/web/src/settings/settings-search.ts",
    status: "added",
    additions: 14,
    deletions: 0,
    patch: [
      "@@ -0,0 +1,14 @@",
      '+import type { SettingsPage, SettingsRow } from "./pages";',
      "+",
      "+/** The pages and rows whose label or description holds every word of `query`. */",
      "+export function filterPages(pages: readonly SettingsPage[], query: string) {",
      "+  const words = query.toLowerCase().split(/\\s+/).filter(Boolean);",
      "+  if (words.length === 0) return pages;",
      "+  const hit = (row: SettingsRow) =>",
      "+    words.every((word) => `${row.label} ${row.description}`.toLowerCase().includes(word));",
      "+  return pages",
      "+    .map((page) => ({ ...page, rows: page.rows.filter(hit) }))",
      "+    .filter((page) => page.rows.length > 0);",
      "+}",
    ].join("\n"),
    binary: false,
    tooLarge: false,
  },
  {
    path: "apps/web/src/settings/settings-nav.tsx",
    status: "modified",
    additions: 5,
    deletions: 1,
    patch: [
      "@@ -18,7 +18,11 @@ export function SettingsNav() {",
      '+  const [query, setQuery] = useState("");',
      "+  const pages = filterPages(SETTINGS_PAGES, query);",
      "   return (",
      '     <nav aria-label="Settings">',
      "-      {SETTINGS_PAGES.map((page) => (",
      "+      <SearchField value={query} onChange={setQuery} autoFocus />",
      "+      {pages.length === 0 && <EmptyResult query={query} />}",
      "+      {pages.map((page) => (",
    ].join("\n"),
    binary: false,
    tooLarge: false,
  },
  {
    path: "apps/web/src/settings/settings-search.test.ts",
    status: "added",
    additions: 52,
    deletions: 0,
    patch: [
      "@@ -0,0 +1,6 @@",
      '+import { describe, expect, it } from "vitest";',
      "+",
      '+describe("filterPages", () => {',
      '+  it("matches words across label and description", () => {',
      '+    expect(names(filterPages(PAGES, "dark mode"))).toEqual(["Appearance"]);',
      "+  });",
    ].join("\n"),
    binary: false,
    tooLarge: false,
  },
];

/** What `simulateDigestStream` added to the realistic orchestrator's transcript. */
export interface MockDigestStream {
  /** The digests it delivered, oldest first. */
  readonly digests: number;
  /** The one that merged something, which the quiet stream never folds. */
  readonly mergedAt: number;
}

/**
 * Dev and screenshot hook, over the realistic scenario: a release afternoon as a live
 * orchestrator's chat gets it, a long run of digests that changed nothing for the user, each with
 * the orchestrator's "nothing is needed from you" reply, and one merge in the middle. What the
 * quiet stream folds, and what "Show all activity" brings back.
 */
export function simulateDigestStream(
  scenes: MockScenes,
  made: Pick<MockRealisticSimulation, "workspaceId" | "orchestratorThreadId" | "searchWorker">,
): MockDigestStream {
  const { host, find, buildLedger, digestMessage } = scenes;
  const now = Date.now();
  const ledger = buildLedger(find(made.workspaceId));
  const search = host.threads().find((thread) => thread.id === made.searchWorker);
  const steps = [
    "The release build is compiling. Nothing is needed from you.",
    "Nothing is needed from you. The release build is about 9 minutes in, with no failures so far.",
    "Still building, 12 minutes in with no failures. Nothing is needed from you.",
    "Still building, 16 minutes in with no failures. Nothing is needed from you.",
    "Clippy passed about 19 minutes into the release build, and the ARM build is still going. Nothing is needed from you.",
    "The release build is 23 minutes in. The Python tests (2,253) and the first deploy guards passed. Still to run: the remaining guards, the Rust tests and the ARM build.",
    "The remaining deploy guards passed. The Rust tests are running. Nothing is needed from you.",
    "The Rust tests passed. Only the ARM build is left. Nothing is needed from you.",
    "Still on the ARM build, about 31 minutes in. Nothing is needed from you.",
    "The ARM build is linking. Nothing is needed from you.",
  ];
  const mergedAfter = 5;
  let generation = 900;
  // Half a minute apart, after the morning's last reply and ending just now: the newest is the one
  // the update's line reads.
  const total = steps.length + 1;
  const at = (index: number) => now - (total - index) * 30_000;
  let index = 0;
  const put = (message: GramUIMessage, when: number) =>
    host.putMessage(made.orchestratorThreadId, {
      ...message,
      metadata: { ...message.metadata, createdAt: when },
    });
  const deliver = (changes: readonly DigestChange[], reason: string) => {
    const facts: OrchestrationDigest = {
      kind: "orchestration",
      variant: "digest",
      generation: ++generation,
      workspaceId: made.workspaceId,
      workspaceName: "Gram",
      reasons: [reason],
      changes,
      reports: [],
      features: ledger.features,
      ...(ledger.groups === undefined ? {} : { groups: ledger.groups }),
      budget: ledger.budget,
      notes: [],
    };
    put(digestMessage(facts), at(index));
  };
  const reply = (said: string) =>
    put(
      {
        id: host.ids(),
        role: "assistant",
        metadata: { createdAt: at(index) + 10_000, agent: "claude", model: "opus" },
        parts: [{ type: "step-start" }, text(said)],
      },
      at(index) + 10_000,
    );
  let mergedAt = 0;
  for (const [step, said] of steps.entries()) {
    if (step === mergedAfter && search !== undefined) {
      mergedAt = at(index);
      deliver([mergedChange(search, "settings-search")], "wake: merge");
      reply(
        `**[#142](${prUrl("example/gram", 142)}) merged.** Search in Settings is on main. The release build goes on.`,
      );
      index += 1;
    }
    deliver([], "wake: release build");
    reply(said);
    index += 1;
  }
  host.emit({ type: "orchestration.changed", workspaceId: made.workspaceId });
  return { digests: index, mergedAt };
}
