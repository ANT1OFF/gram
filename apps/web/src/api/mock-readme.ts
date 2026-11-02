import {
  orchestrationMode,
  type PrStatus,
  type ProjectId,
  type Thread,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
  WORKER_QUESTION_TRIAGE_MS,
} from "@gram/contracts";

import type { MockScenes } from "./mock-orchestration";

// The README's scene: an ordinary morning in one workspace, for the screenshots at the top of the
// repository. Synthetic; nothing here reaches a provider.

/** What `simulateReadme` made, for a shot to navigate by. */
export interface MockReadmeSimulation {
  readonly workspaceId: WorkspaceId;
  readonly orchestratorThreadId: ThreadId;
  /** The one worker whose question the orchestrator passed on. */
  readonly asking: ThreadId;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * `storefront`, across the mock's `api` and `web` repos: the orchestrator's thread with the task it
 * was given and the workers it started. Two run a turn, one waits on CI, one is in review, two
 * merged this morning, and one asks a question the orchestrator passed on with its own note.
 */
export async function simulateReadme(
  scenes: MockScenes,
  projectIds: readonly ProjectId[],
): Promise<MockReadmeSimulation> {
  const {
    host,
    workspaces,
    reports,
    find,
    project,
    create,
    fillSlot,
    buildLedger,
    questionsOf,
    showQuestion,
    digestMessage,
    assistantMessage,
    notFound,
  } = scenes;
  const settings = await host.settings();
  const [api, web = api] = projectIds;
  if (api === undefined || web === undefined) throw notFound("project", "(none)");
  const name = "storefront";
  const state =
    workspaces().find((w) => w.workspace.name === name) ??
    (await create({ name, projectIds: [api, web], homeProjectId: api }));
  const workspaceId = state.workspace.id;
  const orchestrator = await fillSlot(state, settings);
  const now = Date.now();

  host.putMessage(orchestrator.id, {
    id: host.ids(),
    role: "user",
    metadata: { createdAt: now - 3 * HOUR },
    parts: [
      {
        type: "text",
        text: "Next: saved addresses at checkout, search that forgives typos, and the order email.",
      },
    ],
  });
  host.putMessage(
    orchestrator.id,
    assistantMessage([
      {
        type: "text",
        text: "Started six workers: three for checkout, two for search, one for the email. I'll answer what your decisions cover and bring you the rest.",
      },
    ]),
  );

  const spawn = async (projectId: ProjectId, feature: string, title: string, slug: string) => {
    const created = await host.createThread({
      projectRoot: project(projectId).root,
      title,
      mode: orchestrationMode(settings),
      branch: `feat/${slug}`,
    });
    const worker: Thread = {
      ...created,
      workspaceId,
      spawnedBy: { threadId: orchestrator.id, feature },
    };
    host.replace(worker);
    return worker;
  };
  const origin = (projectId: ProjectId) => `example/${project(projectId).name}`;
  const withPr = (
    worker: Thread,
    projectId: ProjectId,
    number: number,
    pr: Partial<PrStatus>,
    git: { readonly behindBase?: number; readonly aheadBase?: number } = {},
  ) =>
    host.setGit(worker.id, {
      repo: true,
      branch: worker.checkout.branch!,
      worktree: true,
      head: `${number}`.padEnd(40, "a"),
      changesToken: `mock-readme-${number}`,
      changedFiles: 0,
      base: "origin/main",
      behindBase: git.behindBase ?? 0,
      aheadBase: git.aheadBase ?? 3,
      conflicts: false,
      upstream: "synced",
      origin: origin(projectId),
      pr: {
        number,
        state: "OPEN",
        url: `https://github.com/${origin(projectId)}/pull/${number}`,
        title: worker.title,
        isDraft: false,
        checks: "passing",
        headMatches: true,
        aheadOfPr: false,
        baseRef: "main",
        headRef: worker.checkout.branch!,
        ...pr,
      },
    });
  const merged = (worker: Thread, projectId: ProjectId, number: number, hoursAgo: number) => {
    withPr(worker, projectId, number, { state: "MERGED" }, { behindBase: 2, aheadBase: 0 });
    host.replace({
      ...worker,
      completedAt: now - hoursAgo * HOUR,
      completedReason: "prMerged",
      lastActivityAt: now - hoursAgo * HOUR,
    });
  };

  // Short titles: the Board's line takes its first worker's, and the README shows it narrow.
  const addressesApi = await spawn(api, "saved-addresses", "Addresses API", "addresses-api");
  const addressForm = await spawn(web, "saved-addresses", "Address picker", "address-picker");
  const cart = await spawn(web, "saved-addresses", "Cart summary", "cart-address");
  const typos = await spawn(api, "search-typos", "Typo tolerance", "search-typos");
  const suggest = await spawn(api, "search-typos", "Search suggestions", "search-suggest");
  const email = await spawn(api, "order-email", "Order email", "order-email");
  const progress = (worker: Thread, summary: string, minutesAgo: number) =>
    reports.set(worker.id, {
      threadId: worker.id,
      state: "progress",
      summary,
      at: now - minutesAgo * MINUTE,
    });

  // The API merged first; the picker builds on it and is with the review bot.
  merged(addressesApi, api, 418, 2);
  reports.set(addressesApi.id, {
    threadId: addressesApi.id,
    state: "done",
    summary: "GET/POST /addresses are in, with tests.",
    prUrl: `https://github.com/${origin(api)}/pull/418`,
    at: now - 2 * HOUR,
  });
  withPr(addressForm, web, 142, {
    review: {
      bots: ["example-code-review"],
      reviewedHead: false,
      roundInFlight: true,
      threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
    },
  });
  host.replace({
    ...addressForm,
    boundPr: { repo: origin(web), number: 142, monitor: false, reviewMonitor: true },
  });
  host.setStatus(cart.id, "running", "Editing src/cart/summary.tsx");
  progress(cart, "The summary reads the chosen address; wiring the edit link.", 9);

  merged(suggest, api, 421, 1);
  withPr(typos, api, 424, { checks: "pending" });
  progress(typos, "Fuzzy matching is in behind the suggestions index; PR open.", 12);
  host.replace({
    ...typos,
    boundPr: { repo: origin(api), number: 424, monitor: true, reviewMonitor: true },
  });

  host.setStatus(email.id, "idle");
  progress(email, "Template drafted; one question on the delivery date.", 7);
  const asked = now - 6 * MINUTE;
  const question: WorkerQuestion = {
    id: "WQ-readme",
    workspaceId,
    threadId: email.id,
    feature: "order-email",
    title: email.title,
    askedAt: asked,
    triageUntil: asked + WORKER_QUESTION_TRIAGE_MS,
    question: "Should the confirmation email show a delivery date?",
    context: "The carrier gives a date range; the checkout page shows none yet.",
    options: [
      { label: "Show the range", description: "As the carrier gives it." },
      { label: "Leave it out", description: "Until checkout shows one too." },
    ],
    recommended: "Leave it out",
    stage: "forwarded",
    forwardedAt: now - 4 * MINUTE,
    forwardedBy: "orchestrator",
    note: "No decision covers this. I'd leave it out so the email matches checkout.",
  };
  questionsOf.set(workspaceId, [question]);
  showQuestion(question);

  const ledger = buildLedger(find(workspaceId));
  host.putMessage(
    orchestrator.id,
    digestMessage({
      kind: "orchestration",
      variant: "digest",
      generation: 1,
      workspaceId,
      workspaceName: name,
      reasons: [],
      changes: [],
      reports: [],
      features: ledger.features,
      ...(ledger.groups === undefined ? {} : { groups: ledger.groups }),
      budget: ledger.budget,
      notes: [],
    }),
  );
  host.emit({ type: "orchestration.changed", workspaceId });
  return { workspaceId, orchestratorThreadId: orchestrator.id, asking: email.id };
}
