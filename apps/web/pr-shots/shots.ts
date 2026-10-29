import { expect, type Locator, type Page } from "@playwright/test";

import { openOrchestrator, pressFirstWorkspaceKey, threadRow } from "../e2e/thread-row";
import { seedNativeUpdate } from "../e2e/native-update-fixture";
import { seedDesktopShell } from "../e2e/desktop-shell-fixture";
import { openOverviewDensity } from "../e2e/overview-density";

// The screens `bun run --filter @gram/web pr:shots` can capture for a PR's before/after images.
// The working tree's list drives both runs: the base checkout serves the app, these drive it. So a
// shot added in a PR that opens a screen or calls a mock control the base lacks fails there, and is
// captured after-only. Add a shot here when the screen you change has none; `--path` covers a route
// that only needs loading.

export type ShotMode = "dark" | "light";

export interface Shot {
  /** The file stem: `<name>-<mode>.before.png`. Kebab-case, unique. */
  readonly name: string;
  /** What it shows, for `--list` and the captions in `shots.md`. */
  readonly title: string;
  /** Both unless given. */
  readonly modes?: readonly ShotMode[] | undefined;
  /** Opens and stages the screen, and resolves once it is ready to capture. */
  readonly open: (page: Page) => Promise<void>;
  /** Captures this element instead of the whole window. */
  readonly element?: ((page: Page) => Locator) | undefined;
}

/**
 * Merges `patch` into the mock's settings before each load. The mock keeps them in sessionStorage
 * and fills a partial save in from the defaults; merging keeps what an earlier seed set.
 */
export const seedMockSettings = (page: Page, patch: Record<string, unknown>) =>
  page.addInitScript((seed) => {
    const key = "gram.mock.settings";
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    for (const [field, value] of Object.entries(seed)) {
      saved[field] = { ...(saved[field] as object | undefined), ...(value as object) };
    }
    sessionStorage.setItem(key, JSON.stringify(saved));
  }, patch);

const openThread = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await page.getByTestId("approval-card").waitFor();
  // Whether the transcript follows the last turns to its end is a race with their rendering, so
  // one run would show the top and the other the end. Both show the end, as a user lands on it.
  const transcript = page.getByTestId("transcript");
  await expect(async () => {
    const gap = await transcript.evaluate((el) => {
      el.scrollTo({ top: el.scrollHeight });
      return el.scrollHeight - el.clientHeight - el.scrollTop;
    });
    expect(gap).toBeLessThanOrEqual(1);
  }).toPass();
};

/** The window's overview sidebar over the mock's seeded threads, tall enough to show it all. */
const openSidebar = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/t/t-flaky");
  await page.getByTestId("overview-sidebar").waitFor();
  await page.waitForTimeout(800);
};

/**
 * The overview's Orchestrators over three workspaces: the seeded one with several workers, one of
 * them running, "billing" with one worker that asks, and "docs" with none. `folded` folds each by
 * its chevron.
 */
const openOrchestrators = async (page: Page, folded: boolean) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const seeded = await mock.simulateOneThread();
    const home = mock.world.projects()[0]!;
    await mock.saveWorkspace({ name: "docs", projectIds: [home.id], homeProjectId: home.id });
    return seeded;
  });
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await page.evaluate(
    (id) => window.gramMock!.simulateStatus(id as never, "running", "Running bun test"),
    made.live,
  );
  const rows = page.getByTestId("overview-workspace");
  await expect(rows).toHaveCount(3);
  if (folded) {
    for (const chevron of await page.getByTestId("overview-workspace-fold").all()) {
      await chevron.click();
    }
  }
  await page.mouse.move(1400, 1300);
  await page.waitForTimeout(800);
};

const openSwitchWorkspace = async (page: Page) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({ claudeSignIn: "signedIn", codexSignIn: "signedIn", ghSignedIn: false }),
    );
  });
  await page.goto("/settings/workspaces");
  await page.getByTestId("workspace-settings").waitFor();
  await page.evaluate(async () => {
    const api = window.gramMock!;
    const made = await api.simulateOrchestration("board");
    const state = (await api.listWorkspaces()).find(
      (each) => each.workspace.id === made.workspaceId,
    )!;
    // An explicit invented Full workspace can admit the local-Codex target shown below.
    await api.setOrchestratorCharter(made.workspaceId, { ...state.charter, autonomy: "full" });
  });
  await page
    .getByRole("listitem", { name: "Workspace agent-platform" })
    .getByTestId("workspace-link")
    .click();
  await page.getByTestId("workspace-page").waitFor();
};

/**
 * An invented workspace's Models at `width` × 1000: an orchestrator model of its own, and a Claude
 * and a Codex worker model, so each row and the Codex notes show.
 */
const openModelsWorkspace = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({ claudeSignIn: "signedIn", codexSignIn: "signedIn", ghSignedIn: false }),
    );
  });
  await page.goto("/settings/workspaces");
  await page.getByTestId("workspace-settings").waitFor();
  await page.evaluate(async () => {
    const api = window.gramMock!;
    const made = await api.simulateOrchestration("board");
    const state = (await api.listWorkspaces()).find(
      (each) => each.workspace.id === made.workspaceId,
    )!;
    const codex = (await api.listModels("codex")).models[0]?.id ?? "gpt-5-codex";
    await api.setOrchestratorCharter(made.workspaceId, {
      ...state.charter,
      autonomy: "full",
      orchestratorModel: { agent: "claude", model: "opus", speed: "standard", variant: "high" },
      workerModels: [
        {
          agent: "claude",
          model: "opus",
          speed: "standard",
          useFor: "implementation",
          default: true,
        },
        { agent: "codex", model: codex, speed: "standard", useFor: "reviews and audits" },
      ],
    });
  });
  await page
    .getByRole("listitem", { name: "Workspace agent-platform" })
    .getByTestId("workspace-link")
    .click();
  await page.getByTestId("worker-models").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
};

/**
 * Settings → Workspaces with the mock's three seeded workspaces. Settings scrolls inside its own
 * pane, so the window grows to the page's height and the shot shows all of it.
 */
const openWorkspaceSettings = async (page: Page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/workspaces");
  await page.waitForFunction(() => window.gramMock !== undefined);
  // In the page rather than by URL: a reload would drop the seeded workspaces.
  await page.evaluate(() => window.gramMock!.seedSidebarLoad());
  await page.getByRole("listitem", { name: "Workspace agent-platform" }).waitFor();
};

/**
 * A seeded workspace's orchestrator at 1440 × 900, opened from its overview row as a user would: the
 * seed lives in memory, so nothing reloads after it.
 */
/** The ask scenario with two failures. */
const seedFailures = () => window.gramMock!.simulateFailures();

/** The failures scenario with a draft and a review waiting, on a solo thread, at 1440 px. */
const openNeedsYouSeeded = async (page: Page) => {
  await seedMockSettings(page, { appearance: { mode: "system" } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  await page.evaluate(seedFailures);
  await page.evaluate(() => {
    const mock = window.gramMock!;
    mock.simulateWaitOnUser("t-deps" as never, {
      kind: "review",
      title: "Review the mock: needs-you-home v1",
    });
    mock.simulateWaitOnUser("t-deps" as never, {
      kind: "draft",
      title: "Draft to send: release note for 0.2.1",
      copy: "Needs you now opens a popover.",
    });
  });
};

const openOrchestratorOf = async (
  page: Page,
  seed: () => Promise<{ readonly orchestratorThreadId: string }>,
) => {
  // The default appearance is dark whatever the system says; light shots need it to follow.
  await seedMockSettings(page, { appearance: { mode: "system" } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const { orchestratorThreadId } = await page.evaluate(seed);
  await openOrchestrator(page, orchestratorThreadId);
  await page.getByLabel("Message", { exact: true }).waitFor();
  // Past the arrivals' motion, so both runs capture a still frame.
  await page.waitForTimeout(800);
};

/**
 * The mock's PR-state threads, one per PR state and checks rolled up, opened from the sidebar: the
 * thread with a PR checking, `t-pr-open`, shows its badge and its row above the composer.
 */
const openPrStateThread = async (page: Page, testId: string) => {
  await seedMockSettings(page, { appearance: { mode: "system" } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  await page.evaluate(() => window.gramMock!.seedPrStates());
  await threadRow(page, "t-pr-open").click();
  await page.getByTestId(testId).first().waitFor();
  // Past the arrivals' motion, so both runs capture a still frame.
  await page.waitForTimeout(800);
};

/** `casefiles`'s orchestrator, then Quiet; resolves to the workspace's id. */
const openQuietBusy = async (page: Page): Promise<string> => {
  await openOrchestratorOf(page, async () => {
    const made = await window.gramMock!.simulateQuietBusy();
    sessionStorage.setItem("gram.shots.workspace", made.workspaceId);
    return made;
  });
  await page.getByTestId("quiet-toggle").click();
  await page.getByTestId("quiet-empty").waitFor();
  return page.evaluate(() => sessionStorage.getItem("gram.shots.workspace") ?? "");
};

/** Board in the title bar's view switcher. */
const openBoardView = async (page: Page) => {
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await page.getByTestId("view-board").waitFor();
};

/** The board workspace's orchestrator, with the workspace paused by the user. */
const openPausedOrchestrator = async (page: Page) => {
  await openOrchestratorOf(page, async () => {
    const made = await window.gramMock!.simulateOrchestration("board");
    sessionStorage.setItem("gram.shots.workspace", made.workspaceId);
    return made;
  });
  await page.evaluate(() =>
    window.gramMock!.setOrchestratorPaused(
      sessionStorage.getItem("gram.shots.workspace") as never,
      true,
    ),
  );
  await page.getByTestId("orchestrator-banner-paused").waitFor();
  await page.waitForTimeout(600);
};

/**
 * The One thread proof's orchestrator in the Orchestrator layout at `width` × 900, the right panel
 * open or closed, with the overview sidebar down the window's left (the base had an in-pane worker
 * rail instead).
 */
const openOverviewHome = async (page: Page, width: number, { panel }: { panel: boolean }) => {
  await seedMockSettings(page, { panel: { open: panel } });
  await openOrchestratorOf(page, () => window.gramMock!.simulateOneThread());
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(800);
};

/** Grows the window to the settings pane's whole height, once that height holds still. */
const fitSettings = async (page: Page) => {
  const height = () =>
    page.evaluate(() => {
      // The pane that scrolls, back at its top: opening a section can scroll it.
      const pane = document.querySelector("[data-settings-results]")?.parentElement;
      if (pane === null || pane === undefined) return 0;
      pane.scrollTop = 0;
      return pane.getBoundingClientRect().top + pane.scrollHeight;
    });
  await expect
    .poll(async () => {
      const before = await height();
      await page.waitForTimeout(300);
      return before > 0 && before === (await height());
    })
    .toBe(true);
  await page.setViewportSize({
    width: 1280,
    height: Math.max(900, Math.ceil(await height()) + 40),
  });
};

/**
 * The mock's "board" workspace beside the seeded threads, with the window tall enough for a long
 * menu. Resolves with the thread ids the scenario made.
 */
const openBoardSidebar = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await openOrchestrator(page, made.orchestratorThreadId);
  await threadRow(page, made.working).waitFor();
  return made;
};

/** Right-clicks `row` and waits for its menu, the element a menu shot captures. */
const rowMenu = async (page: Page, row: Locator) => {
  await row.click({ button: "right" });
  await page.getByRole("menu").waitFor();
  // The menu settles in under the look's motion; the shot is of where it rests.
  await page.waitForTimeout(300);
};

/**
 * The app in the capture's emulated color scheme: the mock's settings default to dark, which an
 * emulated light scheme alone doesn't change.
 */
const followColorScheme = (page: Page) =>
  page.addInitScript(() => {
    const key = "gram.mock.settings";
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    const mode = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    saved["appearance"] = { ...(saved["appearance"] as object | undefined), mode };
    sessionStorage.setItem(key, JSON.stringify(saved));
  });

/** The ⌘J scenario from its orchestrator's thread, reached in the app: a reload drops it. */
/**
 * The reaching-workers scenario where the build has it, else the ⌘J one it builds on, so "before"
 * shows the same workers without what this adds. `reaching` refuses a build without it.
 */
const openReachingScenario = async (page: Page, { reaching = false } = {}) => {
  await followColorScheme(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(async (needed) => {
    const mock = window.gramMock as unknown as Record<string, (() => Promise<unknown>) | undefined>;
    const reach = mock["simulateReachingWorkers"];
    if (reach !== undefined) return reach.call(mock);
    if (needed) throw new Error("this build has no reaching-workers scenario");
    return mock["simulateWorkers"]!.call(mock);
  }, reaching);
  const scenario = made as {
    orchestratorThreadId: string;
    live: string;
    asking: string;
    cleanedUp?: string;
    stuck?: string;
  };
  await openOrchestrator(page, scenario.orchestratorThreadId);
  await page.waitForLoadState("networkidle");
  return scenario;
};

/**
 * ⌘J's Workers list. With the overview open ⌘J jumps into its worker rows instead, so the
 * overview is hidden first, as ⌘B does, the way `e2e/workers-list.spec.ts` opens the list.
 */
const pressWorkersList = async (page: Page) => {
  await page.getByTestId("overview-hide").click();
  await expect(page.getByTestId("overview-sidebar")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await page.getByTestId("workers-list").waitFor();
};

const openWorkersScenario = async (page: Page) => {
  await followColorScheme(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(async () => {
    const mock = window.gramMock;
    if (mock?.simulateWorkers === undefined) throw new Error("this build has no workers scenario");
    return mock.simulateWorkers();
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.waitForLoadState("networkidle");
  return made;
};

const RC18_NOTES =
  "### Features\n\n- Update pill: check, download and restart from the sidebar\n- Settings → Updates follows the same states\n\n### Fixes\n\n- Restart waits for agents to stop";

/** The signed updater's pill in one state, hovered so its hint shows (when this build has it). */
const openUpdatePill = (patch: Parameters<typeof seedNativeUpdate>[1]) => async (page: Page) => {
  await seedNativeUpdate(page, patch);
  await page.setViewportSize({ width: 1180, height: 640 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const pill = page.getByTestId("update-pill");
  if ((await pill.count()) === 0) return;
  await pill.hover();
  await page.locator('[data-slot="tooltip-content"][data-open]').waitFor();
  await page.waitForTimeout(300);
};

const signedReady = {
  status: "ready",
  availableVersion: "0.1.0-rc.18",
  downloadedVersion: "0.1.0-rc.18",
  percent: 100,
  releaseNotes: RC18_NOTES,
  releaseDate: "2026-10-16T17:05:00Z",
  checkedAt: Date.UTC(2026, 9, 16, 17, 12),
} as const;

const UPDATE_PILL_SHOTS: readonly Shot[] = [
  {
    name: "update-pill-checking",
    title: "Update pill: a check the user asked for",
    modes: ["dark"],
    open: openUpdatePill({ status: "checking", manual: true }),
  },
  {
    name: "update-pill-available",
    title: "Update pill: rc.18 available, click to download, notes on hover",
    modes: ["dark"],
    open: openUpdatePill({
      status: "available",
      availableVersion: "0.1.0-rc.18",
      releaseNotes: RC18_NOTES,
      releaseDate: "2026-10-16T17:05:00Z",
    }),
  },
  {
    name: "update-pill-downloading",
    title: "Update pill: downloading, 42%",
    modes: ["dark"],
    open: openUpdatePill({
      status: "downloading",
      availableVersion: "0.1.0-rc.18",
      percent: 42,
      releaseNotes: RC18_NOTES,
    }),
  },
  {
    name: "update-pill-ready",
    title: "Update pill: verified download, click Restart to update",
    open: openUpdatePill(signedReady),
  },
  {
    name: "update-pill-installing",
    title: "Update pill: restarting through the stop fence",
    modes: ["dark"],
    open: openUpdatePill({ ...signedReady, status: "installing" }),
  },
  {
    name: "update-pill-refused",
    title: "Update pill: the stop fence refused the restart; reason in one line",
    modes: ["dark"],
    open: openUpdatePill({
      ...signedReady,
      status: "error",
      errorStep: "install",
      message: "Didn't restart: an agent didn't stop cleanly. Nothing was installed.",
    }),
  },
  {
    name: "update-pill-not-applied",
    title: "Update pill: the last restart's update wasn't applied",
    modes: ["dark"],
    open: openUpdatePill({
      status: "upToDate",
      notApplied: {
        version: "0.1.0-rc.18",
        reason:
          "Gram restarted but macOS kept 0.1.0-rc.17. Squirrel.Mac's log is ~/Library/Caches/io.github.ant1off.gram.ShipIt/ShipIt_stderr.log.",
      },
    }),
  },
  {
    name: "update-settings-signed",
    title: "Settings → Updates on a signed install: the pill's states, notes and restart",
    open: async (page) => {
      await seedNativeUpdate(page, signedReady);
      await page.setViewportSize({ width: 1180, height: 900 });
      await page.goto("/settings/updates");
      await page.getByTestId("updates").waitFor();
    },
  },
  {
    name: "update-settings-public",
    title: "Settings → Updates on a signed install reading a public release repository",
    open: async (page) => {
      await seedNativeUpdate(page, {
        status: "upToDate",
        currentVersion: "0.4.0",
        checkedAt: Date.UTC(2026, 9, 20, 9, 30),
      });
      await page.addInitScript(() => {
        Object.assign(window.gram?.updates ?? {}, {
          source: async () => ({ repo: "example/gram", visibility: "public" }),
        });
      });
      await page.setViewportSize({ width: 1180, height: 900 });
      await page.goto("/settings/updates");
      await page.getByText(/Releases are read anonymously/).waitFor();
    },
  },
  {
    name: "update-settings-refused",
    title: "Settings → Updates after the stop fence refused a restart",
    modes: ["dark"],
    open: async (page) => {
      await seedNativeUpdate(page, {
        ...signedReady,
        status: "error",
        errorStep: "install",
        message: "Didn't restart: an agent didn't stop cleanly. Nothing was installed.",
      });
      await page.setViewportSize({ width: 1180, height: 900 });
      await page.goto("/settings/updates");
      await page.getByTestId("updates").waitFor();
    },
  },
];

/** New task, straight to a worker, in the mock's one-repo world. */
const openDirectTask = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/new-task?way=direct");
  await page.getByRole("form", { name: "New task" }).waitFor();
  await page.getByTestId("task-way-note").waitFor();
  await page.getByRole("button", { name: /Start (workspace and )?worker/ }).waitFor();
  await page.waitForTimeout(600);
};

/** The overview's New menu over the board scenario's workspace, opened from the header's `+`. */
const openNewEntry = async (page: Page) => {
  await openOverviewDensity(page, 280);
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.getByTestId("new-entry").click();
  await page.getByTestId("new-entry-menu").waitFor();
  await page.getByTestId("new-entry-task").hover();
  await page.getByTestId("new-entry-task-to").waitFor();
  await page.waitForTimeout(400);
};

/**
 * Each first screen the New menu lands on, reached by its route in the page (a reload would drop
 * the seeded workspace), so the base can show it too.
 */
const NEW_ENTRY_LANDINGS: readonly Shot[] = (
  [
    ["new-entry-task", "the task for an orchestrator", "/new-task"],
    ["new-entry-worker", "the worker straight away", "/new-task?way=direct"],
    ["new-entry-one-off", "the one-off thread", "/new"],
    ["new-entry-workspace", "the new workspace", "/new-workspace"],
  ] as const
).map(([name, what, path]) => ({
  name,
  title: `The New menu's landing: ${what} (${path})`,
  open: async (page) => {
    await openOverviewDensity(page, 280);
    await page.setViewportSize({ width: 1440, height: 860 });
    await page.evaluate((to) => {
      history.pushState({}, "", to);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await expect(page).toHaveURL(new RegExp(`${path.replace("?", "\\?")}$`));
    await page.mouse.move(1100, 700);
    await page.waitForTimeout(800);
  },
}));

/** A thread whose mock reply raises the change-by-chat card `prompt` asks for. */
const proposalCard = (prompt: string, title: string, name: string): Shot => ({
  name,
  title,
  open: async (page) => {
    await page.setViewportSize({ width: 900, height: 1100 });
    await page.goto("/t/t-deps");
    const composer = page.getByLabel("Message", { exact: true });
    await composer.waitFor();
    await composer.fill(prompt);
    await composer.press("ControlOrMeta+Enter");
    await page.getByTestId("approval-card").last().waitFor();
    await page.waitForTimeout(600);
  },
  element: (page) => page.getByTestId("approval-card").last(),
});

export const SHOTS: readonly Shot[] = [
  ...UPDATE_PILL_SHOTS,
  {
    name: "new-entry-header",
    title: "The overview header with its New control, at the 180 px minimum width",
    open: async (page) => {
      await openOverviewDensity(page, 180);
      await page.mouse.move(1400, 1300);
    },
    element: (page) => page.getByTestId("overview-hide").locator(".."),
  },
  {
    name: "new-entry-menu",
    title: "The header's New menu, with the task's Send to submenu open",
    open: openNewEntry,
  },
  ...NEW_ENTRY_LANDINGS,
  proposalCard("Please change the settings", "A settings change by chat's card", "settings-card"),
  proposalCard(
    "Please create the workspace",
    "A new workspace by chat's card: its projects, then what it will have",
    "workspace-create-card",
  ),
  proposalCard(
    "Please change the workspace",
    "A workspace change by chat's card: projects kept, removed and added, then before → after",
    "workspace-update-card",
  ),
  ...[1200, 520].map((width): Shot => ({
    name: width === 1200 ? "new-task-direct-worker" : "new-task-direct-worker-narrow",
    title: `New task, straight to a worker, at ${width} px: the worker's agent and model`,
    open: (page) => openDirectTask(page, width),
  })),
  {
    name: "new-task-worker-models",
    title: "New task, straight to a worker: the roster's models, each with what it is for",
    open: async (page) => {
      await openDirectTask(page, 1200);
      await page.getByRole("combobox", { name: "Worker model" }).click();
      await page.getByRole("listbox").waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: "settings-window",
    title: "Settings → General → Window in the macOS shell, Open at login waiting for approval",
    open: async (page) => {
      await seedDesktopShell(page, {
        keepInTray: true,
        launchAtLogin: { enabled: true, needsApproval: true },
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/settings/general");
      await page.getByRole("switch", { name: "Show in menu bar" }).waitFor();
      await page.waitForTimeout(300);
    },
    element: (page) => page.getByRole("region", { name: "Window" }),
  },
  {
    name: "settings-notification-delivery",
    title:
      "Settings → Notifications → Desktop in the macOS shell, after a test notification showed",
    open: async (page) => {
      await seedDesktopShell(page, {
        notificationStatus: {
          supported: true,
          last: { outcome: "shown", at: new Date(2026, 9, 25, 14, 2).getTime(), test: true },
        },
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/settings/notifications");
      await page.getByTestId("notification-settings").waitFor();
      await page.waitForTimeout(300);
    },
    element: (page) => page.getByRole("region", { name: "Desktop" }),
  },
  {
    name: "settings-search",
    title: "Settings search: rows found on every page, under their group",
    modes: ["dark"],
    open: async (page) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/settings/general");
      await page.getByTestId("general-settings").waitFor();
      await page.getByRole("textbox", { name: "Search settings" }).fill("worktree");
      await page.waitForTimeout(300);
    },
  },
  {
    name: "workspace-sheet",
    title: "Workspace settings from the orchestrator's header",
    modes: ["dark"],
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOrchestration("board"));
      // A link to the settings page before; a sheet over the orchestrator after.
      await page.getByLabel("Workspace settings", { exact: true }).click();
      await page.getByTestId("workspace-page").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "merged-pr-row",
    title: "A worker whose PR merged: its PR strip row and the worktree cleanup above the composer",
    open: async (page) => {
      await seedMockSettings(page, { appearance: { mode: "system" } });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      const merged = await page.evaluate(
        async () => (await window.gramMock!.simulateFinishedWork()).merged[2]!,
      );
      // In-app, since a reload loses the seeded mock.
      await page.evaluate((id) => {
        history.pushState({}, "", `/t/${id}`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, merged);
      await page.getByTestId("pr-row").waitFor();
      await page.waitForTimeout(800);
    },
  },
  {
    name: "quiet-busy",
    title:
      "Quiet over `casefiles`, its workers peeked: two running, three waiting on CI, the review bot or a dependency, one on a conflict",
    open: async (page) => {
      const made = await openQuietBusy(page);
      await page.locator(`[data-testid="quiet-strip-workspace"][data-workspace="${made}"]`).click();
      await page.getByTestId("quiet-peek").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "quiet-busy-board",
    title: "The same `casefiles` workers on the Board: the chips agree with Quiet's dots",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateQuietBusy());
      await openBoardView(page);
      await page.getByTestId("rail-worker").first().waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "live-feature-cards",
    title:
      "The finished-work board's orchestrator: live feature cards in place of the digest's ledger table",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateFinishedWork());
      await page.getByLabel("Message", { exact: true }).waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "digest-line",
    title: "The orchestrator's stream: its digests as one quiet line, collapsed, under the cards",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOneThread());
      await page.getByTestId("feature-card").first().waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "digest-line-open",
    title: "A digest line opened in place: reasons, reports, ledger and the text sent to the agent",
    modes: ["dark"],
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOneThread());
      // A base without the line has nothing to open, and captures the stream as it was.
      const line = page.getByTestId("digest-line-toggle").last();
      if ((await line.count()) > 0) {
        await line.focus();
        await page.keyboard.press("Enter");
        await page.getByTestId("digest-line-details").scrollIntoViewIfNeeded();
      }
      await page.waitForTimeout(600);
    },
  },
  {
    name: "live-feature-cards-since-you-left",
    title:
      "Back after 2½ hours: Since you left above the ask stack (a merge, a block, asks, limit)",
    open: async (page) => {
      await openOrchestratorOf(page, () => {
        const mock = window.gramMock;
        if (mock?.simulateLiveCards === undefined) throw new Error("this build has no live cards");
        return mock.simulateLiveCards();
      });
      await page.getByTestId("since-you-left").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "workspace-pause-confirm",
    title: "Pause beside Tidy up in the title bar, asking first while work is mid-turn",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOrchestration("board"));
      await page.getByTestId("titlebar-pause").click();
      await page.getByTestId("titlebar-pause-confirm").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "workspace-paused",
    title:
      "A paused workspace: the title bar, the orchestrator's banner and the overview's worker rows",
    open: async (page) => {
      await openPausedOrchestrator(page);
    },
  },
  {
    name: "workspace-paused-board",
    title: "A paused workspace's Board: Resume, and what the pause does to its workers",
    open: async (page) => {
      await openPausedOrchestrator(page);
      await openBoardView(page);
      await page.getByTestId("rail-paused-line").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "workspace-pause-at-limit",
    title: "Workspace settings: Pause new workers at a share of a limit",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOrchestration("board"));
      await page.getByLabel("Workspace settings", { exact: true }).click();
      await page.getByTestId("workspace-page").waitFor();
      // Where the row sits: under Workers at once.
      await page.getByText("Workers at once", { exact: true }).first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "workspace-models-group",
    title: "Workspace settings: Models, with routing at a limit and the worker brief footer",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOrchestration("board"));
      await page.getByLabel("Workspace settings", { exact: true }).click();
      await page.getByTestId("workspace-page").waitFor();
      await page.getByRole("region", { name: "Models" }).waitFor();
      await page.waitForTimeout(600);
    },
    element: (page) => page.getByRole("region", { name: "Models" }),
  },
  {
    name: "workspace-autonomy",
    title: "Workspace settings: Autonomy at Full, its selected level marked",
    open: async (page) => {
      await openSwitchWorkspace(page);
      await page.getByTestId("autonomy").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
    element: (page) => page.getByTestId("autonomy"),
  },
  {
    name: "workspace-idle-compact",
    title: "Workspace settings: Compact idle threads (on by default)",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOrchestration("board"));
      await page.getByLabel("Workspace settings", { exact: true }).click();
      await page.getByTestId("workspace-page").waitFor();
      // Where the new rows sit, under Pause new workers at; the base shows that row last.
      await page
        .getByText("Pause new workers at", { exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "workspace-orchestrator-preference",
    title: "Invented workspace settings: future preference and the explicit current-session switch",
    modes: ["dark"],
    open: async (page) => {
      await openSwitchWorkspace(page);
      await page.getByTestId("orchestrator-model").scrollIntoViewIfNeeded();
    },
  },
  {
    name: "switch-orchestrator-confirm",
    title:
      "Invented CLI catalog: current Claude session, requested Codex model and bounded context handoff",
    modes: ["dark"],
    open: async (page) => {
      await openSwitchWorkspace(page);
      await page.getByTestId("switch-orchestrator-open").click();
      await page
        .getByTestId("switch-orchestrator-dialog")
        .getByRole("combobox", { name: "Agent", exact: true })
        .click();
      await page.getByRole("option", { name: "Codex", exact: true }).click();
      await expect(page.getByTestId("switch-model-availability")).toContainText(
        "Listed by your installed CLI",
      );
    },
    element: (page) => page.getByTestId("switch-orchestrator-dialog"),
  },
  {
    name: "switch-orchestrator-waiting",
    title:
      "Invented switch in progress: previous Claude identity and requested Codex remain separate",
    modes: ["dark"],
    open: async (page) => {
      await openSwitchWorkspace(page);
      await page.evaluate(() => {
        window.gramMockHoldGates = true;
      });
      await page.getByTestId("switch-orchestrator-open").click();
      const dialog = page.getByTestId("switch-orchestrator-dialog");
      await dialog.getByRole("combobox", { name: "Agent", exact: true }).click();
      await page.getByRole("option", { name: "Codex", exact: true }).click();
      await expect(dialog.getByTestId("switch-model-availability")).toContainText(
        "Listed by your installed CLI",
      );
      await dialog.getByTestId("switch-orchestrator-confirm").click();
      await expect(dialog.getByTestId("orchestrator-switch-status")).toContainText(
        "Requested: Codex",
      );
    },
    element: (page) => page.getByTestId("switch-orchestrator-dialog"),
  },
  ...["Neutral", "Rose", "Forest", "Ocean", "Ember", "Violet"].map((name): Shot => ({
    name: `palette-${name.toLowerCase()}`,
    title: `${name} palette: scripted chat, sidebar, PR statuses, code and diff`,
    open: async (page) => {
      const id = name.toLowerCase();
      await seedMockSettings(page, { appearance: { paletteId: id } });
      await page.addInitScript(() => {
        sessionStorage.setItem(
          "gram.mock.launchChecks",
          JSON.stringify({
            tools: [
              { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
              { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.159.2" },
              { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
              { tool: "gh", found: false },
            ],
            claudeSignIn: "notSignedIn",
            ghSignedIn: false,
          }),
        );
        sessionStorage.setItem("gram.mock.agents", "claude,codex");
      });
      await openThread(page);
      await expect(page.locator("html")).toHaveAttribute(
        "data-palette",
        new RegExp(`^${id}(-dark)?$`),
      );
    },
  })),

  {
    name: "ask-stack-board",
    title: "The board scenario's orchestrator: every ask once, above the composer",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOrchestration("board"));
    },
  },
  {
    name: "board-view",
    title: "Board: the ask stack's scenario as feature lines, the stack docked below",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateAsks());
      await page
        .getByRole("radiogroup", { name: "View" })
        .getByRole("radio", { name: /^Board\b/ })
        .click();
      await page.getByTestId("view-board").waitFor();
      await page.waitForTimeout(800);
    },
  },
  {
    name: "board-waiting",
    title: "Board: the header's controls, and its waiting chip unfolding Waiting on you",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateWorkerWaits());
      await openBoardView(page);
      // A base without the chip shows its Board as it was.
      const chip = page.getByTestId("rail-waiting-chip");
      if ((await chip.count()) > 0) await chip.click();
      await page.waitForTimeout(800);
    },
  },
  {
    name: "board-groups",
    title: "Board: lines under their groups' bands, with stages as chips and pips",
    open: async (page) => {
      await openOrchestratorOf(page, async () => {
        const made = await window.gramMock!.simulateReleaseGroup();
        await window.gramMock!.setOrchestratorStage(made.workspaceId, {
          feature: "mail-trigger",
          plan: ["contract", "build", "rollout"],
          stage: "build",
          note: "Contract agreed with the payments team.",
        });
        return made;
      });
      await openBoardView(page);
      await page.waitForTimeout(800);
    },
  },
  {
    name: "board-failing",
    title: "Board: the Failing strip above the docked stack, a stopped worker and red CI",
    open: async (page) => {
      await openOrchestratorOf(page, seedFailures);
      await openBoardView(page);
      await page.waitForTimeout(800);
    },
  },
  {
    name: "board-group-menu",
    title: "A feature's menu on the Board, with Edit plan… and Move to group",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateReleaseGroup());
      await openBoardView(page);
      const line = page.locator('[data-testid="rail-row"][data-feature="mail-trigger"]');
      await line.hover();
      await line.getByTestId("feature-menu").click();
      await page.waitForTimeout(800);
    },
  },
  {
    name: "feature-sheet",
    title: "A feature opened from its Board line: stations, PRs and workers, with its menu",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateAsks());
      await page
        .getByRole("radiogroup", { name: "View" })
        .getByRole("radio", { name: /^Board\b/ })
        .click();
      await page
        .locator('[data-testid="rail-row"][data-feature="mail-trigger"]')
        .getByTestId("rail-feature")
        .click();
      await page.getByTestId("feature-sheet").waitFor();
      await page.waitForTimeout(800);
    },
  },
  {
    name: "ask-stack-shapes",
    title: "The ask stack's scenario, all asks shown: a three-way push, options, a free-form reply",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateAsks());
      // The free-form question with drafted replies as the current ask, which is when they're asked.
      const chip = page.getByTestId("ask-reply-chip").first();
      for (let step = 0; step < 6 && !(await chip.isVisible()); step++) {
        await page.getByTestId("ask-next").click();
        await page.waitForTimeout(300);
      }
      await chip.waitFor();
      await page.getByTestId("ask-expand").click();
      await page.waitForTimeout(800);
    },
  },
  {
    name: "needs-you",
    title: "Needs you: the pill opens a popover of every workspace's items; before, the Board",
    open: async (page) => {
      await openNeedsYouSeeded(page);
      await page.getByTestId("overview-needs-you").click();
      await page.locator('[data-testid="needs-you-popover"], [data-testid="view-board"]').waitFor();
      // Past the arrivals' motion, so both runs capture a still frame.
      await page.waitForTimeout(800);
    },
  },
  {
    name: "needs-you-panel",
    title: "Needs you: See all opens the whole list as the right panel beside the thread",
    open: async (page) => {
      await openNeedsYouSeeded(page);
      await page.getByTestId("overview-needs-you").click();
      await page.getByTestId("needs-you-see-all").click();
      await page.getByTestId("needs-you-panel").waitFor();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(800);
    },
  },
  {
    name: "needs-you-landed",
    title: "Needs you: a row opens its thread at the card that asks, ringed for a moment",
    open: async (page) => {
      await openNeedsYouSeeded(page);
      await page.getByTestId("overview-needs-you").click();
      await page
        .getByTestId("needs-you-item")
        .filter({ hasText: "gh pr merge 91 --squash" })
        .getByTestId("needs-you-open")
        .click();
      await page.locator('[data-needs-you-flash="true"]').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: "needs-you-threads",
    title: "Needs you on threads outside any workspace: their questions, plans and errors too",
    open: async (page) => {
      await seedMockSettings(page, { appearance: { mode: "system" } });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/t/t-deps");
      await threadRow(page, "t-deps").waitFor();
      await page.evaluate(() =>
        window.gramMock!.simulateTurnError(
          "t-docs" as never,
          {
            kind: "rateLimit",
            httpStatus: 429,
            retryable: true,
            text: "The provider is rate limiting requests (HTTP 429). Try again in a moment.",
          },
          "Carry on with the brief",
        ),
      );
      await page.getByTestId("overview-needs-you").click();
      await page.getByTestId("needs-you-popover").waitFor();
      await page.waitForTimeout(800);
    },
  },
  {
    name: "needs-you-empty",
    title: "Needs you with nothing waiting: the popover says so",
    open: async (page) => {
      await seedMockSettings(page, { appearance: { mode: "system" } });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/t/t-deps");
      await threadRow(page, "t-deps").waitFor();
      // The seed's threads that ask, a question and a plan, parked: nothing needs you.
      await page.evaluate(async () => {
        for (const id of ["t-question", "t-plan"]) await window.gramMock!.park(id as never, true);
      });
      await page.getByTestId("overview-needs-you").click();
      await page.getByTestId("needs-you-popover").waitFor();
      await page.waitForTimeout(800);
    },
  },
  ...[1440, 1000].map((width): Shot => ({
    name: `workspace-models-${width}`,
    title: `Workspace settings → Models at ${width} px: an orchestrator model and two worker models`,
    modes: ["dark"],
    open: async (page) => {
      await openModelsWorkspace(page, width);
    },
    element: (page) =>
      page
        .getByTestId("workspace-page")
        .locator("section")
        .filter({ has: page.getByTestId("worker-models") }),
  })),
  {
    name: "workspace-models-notes",
    title: "Workspace settings → Models: How Codex differs, opened",
    modes: ["dark"],
    open: async (page) => {
      await openModelsWorkspace(page, 1440);
      await page.getByRole("button", { name: "How Codex differs" }).click();
      await page.getByTestId("harness-note-dreams").waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: "usage-overview",
    title: "Recorded usage: baseline home without an overview; Usage with invented local totals",
    open: async (page) => {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.addInitScript(() => {
        sessionStorage.setItem("gram.mock.usage", "sample");
        sessionStorage.setItem("gram.mock.agents", "claude,codex");
        sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
        sessionStorage.setItem(
          "gram.mock.launchChecks",
          JSON.stringify({
            tools: [
              { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
              { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.162.1" },
              { tool: "git", found: true },
              { tool: "gh", found: true },
            ],
            claudeSignIn: "notSignedIn",
            codexSignIn: "notSignedIn",
            ghSignedIn: false,
          }),
        );
      });
      await page.goto("/");
      await page.getByTestId("app-shell").waitFor();
      const hasOverview = await page.evaluate(
        () => typeof window.gramMock?.usageOverview === "function",
      );
      if (hasOverview) {
        await page.getByRole("button", { name: "Usage", exact: true }).click();
        // Seven days on the page before the limits-first redesign, thirty after it.
        await expect(page.getByTestId("usage-tokens")).toHaveText(/^(468,000|2\.3M)$/);
      } else {
        await expect(page.getByRole("button", { name: "Usage", exact: true })).toHaveCount(0);
      }
      await page
        .getByTestId("launch-checks-banner")
        .getByRole("button", { name: "Dismiss" })
        .click();
    },
  },
  {
    name: "usage-history-models",
    title: "Usage history/model fix: immutable empty-store baseline vs invented older CLI records",
    open: async (page) => {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.addInitScript(() => {
        sessionStorage.setItem("gram.mock.usage", "history-after");
        sessionStorage.setItem("gram.mock.agents", "claude,codex");
        sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
        sessionStorage.setItem(
          "gram.mock.launchChecks",
          JSON.stringify({
            tools: [
              { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
              { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.162.1" },
              { tool: "git", found: true },
              { tool: "gh", found: true },
            ],
            claudeSignIn: "notSignedIn",
            codexSignIn: "notSignedIn",
            ghSignedIn: false,
          }),
        );
      });
      await page.goto("/");
      await page.getByTestId("app-shell").waitFor();
      const hasOverview = await page.evaluate(
        () => typeof window.gramMock?.usageOverview === "function",
      );
      if (hasOverview) {
        await page.getByRole("button", { name: "Usage", exact: true }).click();
        await expect(page.getByTestId("usage-tokens")).toHaveText(
          process.env["GRAM_PR_SHOTS_LABEL"] === "before" ? "0" : "227",
        );
      } else {
        await expect(page.getByRole("button", { name: "Usage", exact: true })).toHaveCount(0);
      }
      await page
        .getByTestId("launch-checks-banner")
        .getByRole("button", { name: "Dismiss" })
        .click();
    },
  },
  {
    name: "orchestrators-open",
    title: "Orchestrators open: several workers (one running), one that asks, and none",
    open: (page) => openOrchestrators(page, false),
    element: (page) => page.getByTestId("overview-section-orchestrators"),
  },
  {
    name: "orchestrators-folded",
    title: "The same Orchestrators, each folded by its chevron",
    open: (page) => openOrchestrators(page, true),
    element: (page) => page.getByTestId("overview-section-orchestrators"),
  },
  {
    name: "sidebar-catppuccin",
    title: "The overview sidebar in Catppuccin (Latte light, Mocha dark)",
    open: async (page) => {
      await seedMockSettings(page, { appearance: { paletteId: "catppuccin-latte" } });
      await openSidebar(page);
    },
    element: (page) => page.getByTestId("overview-sidebar"),
  },
  {
    name: "thread",
    title: "The scripted thread, stopped on an approval",
    open: openThread,
  },
  {
    name: "transcript-markdown",
    title:
      "The scripted thread's last reply: a list, bold and inline code, and a highlighted block",
    open: async (page) => {
      await openThread(page);
      await page.getByTestId("approval-allow").click();
      const code = page.locator('[data-streamdown="code-block-body"]').filter({
        hasText: "tickAsync",
      });
      // Highlighted: Shiki has coloured the tokens, so the block is shown as it stays.
      await code.locator("span[style]").first().waitFor();
      await expect(page.getByTestId("pane-status")).toHaveText("Idle");
      await code.scrollIntoViewIfNeeded();
    },
    element: (page) => page.getByTestId("transcript"),
  },
  ...(
    [
      ["claude", "t-edits", "Claude's Edit, MultiEdit and Write calls in a transcript"],
      ["codex", "t-edits-codex", "Codex file changes in a transcript"],
    ] as const
  ).map(([agent, id, title]): Shot => ({
    name: `transcript-edits-${agent}`,
    title,
    open: async (page) => {
      await page.setViewportSize({ width: 1440, height: 1400 });
      await page.goto(`/t/${id}`);
      await page.getByTestId("message-assistant").last().waitFor();
      await page.getByTestId("transcript").evaluate((el) => el.scrollTo({ top: 0 }));
    },
  })),
  {
    name: "transcript-edit-open",
    title: "A Claude edit opened to its diff, the run below it opened to its steps",
    modes: ["dark"],
    open: async (page) => {
      await page.setViewportSize({ width: 1440, height: 1400 });
      await page.goto("/t/t-edits");
      await page.getByTestId("message-assistant").last().waitFor();
      await page.getByTestId("file-edit").first().getByRole("button").last().click();
      await page.getByTestId("tool-group").first().getByRole("button").first().click();
      await page.getByTestId("transcript").evaluate((el) => el.scrollTo({ top: 0 }));
    },
  },
  {
    name: "received-message",
    title: "A message another thread sent, with its sender line and thread links",
    open: async (page) => {
      await page.goto("/t/t-dark");
      await page.getByTestId("message-origin").waitFor();
      await page.getByTestId("message-assistant").first().waitFor();
    },
    element: (page) => page.getByTestId("transcript"),
  },
  {
    name: "orchestrator-worker-message",
    title: "A worker's message in its orchestrator's transcript, beside the user's own",
    open: async (page) => {
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      const made = await page.evaluate(async () => {
        const scenario = await window.gramMock?.simulateOrchestration();
        if (!scenario) throw new Error("the mock API isn't on this page");
        return scenario;
      });
      await openOrchestrator(page, made.orchestratorThreadId);
      await page.evaluate(({ orchestratorThreadId, workerThreadId }) => {
        const mock = window.gramMock!;
        const worker = mock.world.summary(workerThreadId as never).thread;
        const at = Date.UTC(2026, 9, 20, 9, 42);
        mock.simulateMessage(orchestratorThreadId as never, {
          id: "shot-user",
          role: "user",
          metadata: { createdAt: at },
          parts: [{ type: "text", text: "Merge #431 once its checks are green." }],
        });
        mock.simulateMessage(orchestratorThreadId as never, {
          id: "shot-worker",
          role: "user",
          metadata: { createdAt: at + 60_000 },
          parts: [
            {
              type: "text",
              text: "Opened #431. The user explicitly reconfirmed it can merge without review, so please perform the coordinator merge.",
            },
            {
              type: "data-thread-origin",
              id: "shot-worker",
              data: {
                threadId: workerThreadId as never,
                title: worker.title,
                depth: 2,
                feature: "rate-limit-headers",
              },
            },
          ],
        });
      }, made);
      await page.getByText("please perform the coordinator merge").waitFor();
      const transcript = page.getByTestId("transcript");
      await expect(async () => {
        const gap = await transcript.evaluate((el) => {
          el.scrollTo({ top: el.scrollHeight });
          return el.scrollHeight - el.clientHeight - el.scrollTop;
        });
        expect(gap).toBeLessThanOrEqual(1);
      }).toPass();
    },
    element: (page) => page.getByTestId("transcript"),
  },
  {
    name: "preview-file-cards",
    title: "Cards for a report and a dashboard an agent wrote, the report open in the Preview tab",
    open: async (page) => {
      await page.goto("/t/t-deps");
      await threadRow(page, "t-deps").waitFor();
      await page.waitForFunction(() => window.gramMock !== undefined);
      await page.evaluate(() => {
        const mock = window.gramMock!;
        mock.simulateWrittenFile(
          "t-deps" as never,
          "/tmp/gram-report/REPORT.md",
          "# Quarterly report\n\nAll green.\n\n- Builds: 42\n- Failures: 0\n",
        );
        mock.simulateWrittenFile(
          "t-deps" as never,
          "/tmp/gram-report/dashboard.html",
          "<h1>Hi</h1>",
        );
      });
      await page.getByRole("button", { name: "Open REPORT.md" }).click();
      await page.getByTestId("preview-markdown").getByRole("heading").first().waitFor();
    },
  },
  {
    name: "connectors-cold",
    title: "The Connectors tab of an archived thread with no session running",
    open: async (page) => {
      await page.goto("/t/t-deps");
      const panel = page.getByTestId("right-panel");
      await panel.getByRole("tab", { name: "Connectors", exact: true }).click();
      // Before: the bare empty state. After: the reason, over the agent's configured servers.
      await panel
        .getByText("Start the thread to see its connectors.")
        .or(panel.getByTestId("connectors-snapshot"))
        .first()
        .waitFor();
    },
    element: (page) => page.getByTestId("right-panel"),
  },
  {
    name: "command-palette",
    title: "The command palette over the thread",
    open: async (page) => {
      await openThread(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("command-palette").waitFor();
    },
  },
  {
    name: "new-thread",
    title: "The new-thread form",
    open: async (page) => {
      await page.goto("/new");
      await page.getByRole("form", { name: "New thread" }).waitFor();
    },
  },
  {
    name: "appearance-palette-library",
    title: "Appearance palette library: existing palettes and six new light/dark pairs",
    open: async (page) => {
      await page.setViewportSize({ width: 1440, height: 2400 });
      await page.goto("/settings/appearance");
      await page.getByRole("heading", { name: "Palette", exact: true }).waitFor();
    },
    element: (page) => page.getByRole("heading", { name: "Palette", exact: true }).locator(".."),
  },
  {
    name: "settings-help",
    title: "Settings → What's New in the desktop app, with its Acknowledgements link",
    open: async (page) => {
      await seedNativeUpdate(page, {});
      await page.addInitScript(() => {
        Object.assign(window.gram ?? {}, { openAcknowledgements: async () => true });
      });
      await page.setViewportSize({ width: 1180, height: 700 });
      await page.goto("/settings/help");
      await page.getByRole("button", { name: "Acknowledgements" }).waitFor();
    },
  },
  {
    name: "settings-appearance",
    title: "Settings → Appearance",
    open: async (page) => {
      await page.goto("/settings/appearance");
      await page.locator("[data-settings-results] h2").first().waitFor();
    },
  },
  {
    name: "settings-storage",
    title: "Settings → Storage: worktrees across repos by group, with sizes and free space",
    open: async (page) => {
      await page.setViewportSize({ width: 1440, height: 2000 });
      await page.goto("/settings/storage");
      await page.getByTestId("storage-group-foreign").waitFor();
      // Every size counted, so the totals read as they settle.
      await expect(page.getByTestId("storage-disk")).not.toContainText("at least");
    },
  },
  {
    name: "worktrees-dialog",
    title: "A repo's Worktrees dialog, which now links to every repo in Storage",
    open: async (page) => {
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByTestId("command-palette");
      await palette.getByRole("combobox").fill(">Worktrees");
      await palette.getByRole("combobox").press("Enter");
      await page.getByTestId("worktree-row").first().waitFor();
    },
    element: (page) => page.getByTestId("worktrees-dialog"),
  },
  {
    name: "storage-cleanup-inactive",
    title: "Clean up inactive: the worktrees and space it frees, before one confirmation",
    open: async (page) => {
      await page.goto("/settings/storage");
      await page.getByRole("radio", { name: "60 days" }).click();
      await page.getByTestId("storage-cleanup-inactive").click();
      await page.getByTestId("storage-plan-summary").waitFor();
    },
    element: (page) => page.getByTestId("storage-inactive-plan"),
  },
  {
    name: "close-clean-worktree",
    title: "Closing a thread whose worktree is clean and pushed",
    open: async (page) => {
      await page.goto("/t/t-deps");
      await threadRow(page, "t-deps").waitFor();
      await page.evaluate(() => {
        window.gramMock?.world.publishGit("t-deps" as never, {
          repo: true,
          branch: "chore/deps",
          worktree: true,
          head: "9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
          changesToken: "mock-deps-clean",
          changedFiles: 0,
          base: "origin/main",
          behindBase: 0,
          aheadBase: 2,
          conflicts: false,
          upstream: "synced",
          origin: "example/api",
        });
      });
      await page.getByRole("button", { name: "Thread menu" }).first().click();
      await page.getByRole("menuitem", { name: /Close thread/ }).click();
      await page.getByTestId("close-thread-dialog").waitFor();
    },
    element: (page) => page.getByTestId("close-thread-dialog"),
  },
  {
    name: "titlebar",
    title: "The title bar over a thread: the usage meter, then four controls",
    open: openThread,
    element: (page) => page.getByTestId("shell-titlebar"),
  },
  {
    name: "titlebar-1440",
    title: "The orchestrator's title bar at 1440 px, a laptop's width, with the right panel open",
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: true });
    },
    element: (page) => page.getByTestId("shell-titlebar"),
  },
  {
    name: "titlebar-folded-worker-menu",
    title: "A folded title bar's thread menu on a worker with a branch, at 1280 px",
    open: async (page) => {
      await openOrchestratorOf(page, async () => {
        const mock = window.gramMock!;
        const made = await mock.simulateOrchestration("board");
        sessionStorage.setItem("pr-shots.worker", made.inReview);
        return made;
      });
      const worker = await page.evaluate(() => sessionStorage.getItem("pr-shots.worker")!);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate((to) => {
        history.pushState(history.state, "", to);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      }, `/t/${worker}`);
      const bar = page.getByTestId("shell-titlebar");
      await expect(bar).toHaveAttribute("data-folded", "true");
      await bar.getByRole("button", { name: "Thread menu" }).click();
      await page.getByTestId("thread-menu").getByRole("menuitem", { name: "More…" }).waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "titlebar-usage",
    title:
      "The usage meter open: 5-hour and weekly use with resets, a quiet reading's age and a forecast",
    open: async (page) => {
      await openThread(page);
      await page.getByTestId("usage-meter").click();
      await page.getByRole("dialog", { name: "Subscription usage" }).waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "context-hover",
    title: "The context ring's hover beside Send: the share of the window and the tokens it is",
    open: async (page) => {
      await openThread(page);
      await page.getByTestId("usage-ring").hover();
      await page.getByTestId("usage").waitFor();
      await page.waitForTimeout(600);
    },
    element: (page) => page.getByRole("dialog", { name: "Usage" }),
  },
  {
    name: "titlebar-layout",
    title: "The layout picker open, its six presets in one popover",
    open: async (page) => {
      await openThread(page);
      await page.getByRole("button", { name: /^Layout: / }).click();
      await page.getByRole("radiogroup", { name: "Layout" }).waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "one-thread-home",
    title:
      "The One thread proof: one workspace's home with live cards, asks and the Workers button",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOneThread());
    },
  },
  {
    name: "one-thread-workers",
    title: "The title bar's Workers button open on the proof's workers",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOneThread());
      await page.getByTestId("workers-button").click();
      await page.getByTestId("workers-list").waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "peek-worker",
    title: "A worker's name on a live card, peeked at in a sheet over the orchestrator",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOneThread());
      await page
        .getByTestId("feature-card")
        .getByTestId("worker-link")
        .filter({ hasText: /^Retry with backoff$/ })
        .click();
      await page.getByTestId("peek-sheet").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "pr-badge-checks-running",
    title: "A thread's PR badge with checks running: the pending mark beside #301",
    element: (page) => page.getByTestId("pane-pr-badge"),
    open: (page) => openPrStateThread(page, "pane-pr-badge"),
  },
  {
    name: "pr-row-checks-running",
    title: "The thread's PR row above the composer, its checks running: the pending mark by #301",
    element: (page) => page.getByTestId("pr-row").first(),
    open: (page) => openPrStateThread(page, "pr-row"),
  },
  {
    name: "peek-pr",
    title: "A PR chip on a live card, peeked at in a sheet: what Gram knows of api#212",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateOneThread());
      await page
        .getByTestId("feature-card")
        .getByTestId("pr-chip")
        .filter({ hasText: /^api#212$/ })
        .click();
      await page.getByTestId("peek-sheet").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "overview-sidebar-narrow",
    title: "An Open overview beside the chat at 520 px, retaining the Glass pane margins",
    open: async (page) => {
      await seedMockSettings(page, { layout: { overviewSidebar: "open" } });
      await openOverviewHome(page, 520, { panel: false });
      await page.getByTestId("overview-sidebar").waitFor();
    },
  },
  {
    name: "overview-sidebar",
    title:
      "The overview sidebar at 1440 px: Needs you, the orchestrators with the current one's workers, and solo threads (before: the in-pane worker rail)",
    open: (page) => openOverviewHome(page, 1440, { panel: false }),
  },
  {
    name: "overview-row-menu",
    title:
      "A solo thread's menu in the overview, by right-click (before: no menu on overview rows)",
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: false });
      await threadRow(page, "t-flaky").click({ button: "right" });
      await page.getByRole("menu").waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: "overview-parked",
    title: "Parked solo threads folded under Solo threads, opened (before: not in the overview)",
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: false });
      await page.getByTestId("overview-parked").getByRole("button").click();
      await page.waitForTimeout(300);
    },
    element: (page) => page.getByTestId("overview-sidebar"),
  },
  {
    name: "overview-many-solo",
    title:
      "150 solo threads in the overview, scrolled into the middle of the list (after: only the rows near the view are drawn)",
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: false });
      await page.evaluate(() => window.gramMock!.seedBusyThreads({ streaming: 0, idle: 150 }));
      await page.getByText("Quiet thread 1", { exact: true }).waitFor();
      await page
        .getByTestId("overview-sidebar")
        .locator(".overflow-y-auto")
        .first()
        .evaluate((scroller) => {
          scroller.scrollTop = 2_000;
        });
      await page.waitForTimeout(600);
    },
    element: (page) => page.getByTestId("overview-sidebar"),
  },
  {
    name: "overview-sidebar-extras",
    title:
      "The overview at 1440 px with Pull requests and Done today opened, and its foot: usage meters and worker slots",
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: false });
      for (const id of ["pullRequests", "doneToday"]) {
        const title = page
          .getByTestId(`overview-section-${id}`)
          .getByRole("heading")
          .getByRole("button");
        if ((await title.getAttribute("aria-expanded")) === "false") await title.click();
      }
      await page.getByTestId("overview-done").first().waitFor();
      await page.getByTestId("overview-foot").waitFor();
      // Done today sits last in the column, above the foot.
      await page.getByTestId("overview-done").last().scrollIntoViewIfNeeded();
      // Off the column, so no row shows its hover.
      await page.mouse.move(1200, 400);
      await page.waitForTimeout(400);
    },
  },
  {
    name: "overview-sidebar-hover",
    title: "A worker's hover card in the overview: title, station, now line, first PR and time",
    modes: ["dark"],
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: false });
      await page.getByTestId("overview-worker").nth(1).hover();
      await page.getByTestId("overview-worker-card").waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "overview-sidebar-hidden",
    title:
      "The overview hidden with ⌘B: Show sidebar at the title bar's left brings it back (before: no way back but ⌘B)",
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: false });
      await page.keyboard.press("ControlOrMeta+b");
      await page.getByTestId("overview-sidebar").waitFor({ state: "detached" });
      await page.waitForTimeout(400);
    },
  },
  {
    name: "overview-sidebar-compact",
    title:
      "The overview at 1100 px, automatic so compact: Needs you, a tile per workspace with its ask badge and workers, then solo threads",
    open: async (page) => {
      await openOverviewHome(page, 1100, { panel: false });
      await page.getByTestId("overview-rail").waitFor();
    },
  },
  {
    name: "overview-sidebar-flyout",
    title:
      "A compact tile's flyout: the current workspace's live workers, as the open overview lists them",
    modes: ["dark"],
    open: async (page) => {
      await openOverviewHome(page, 1100, { panel: false });
      await page.locator('[data-testid="overview-tile"][aria-current="true"]').hover();
      await page.locator('[data-testid="overview-flyout"][data-open]').waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "orchestrator-menu-switch",
    title: "The orchestrator's ⋯ menu with Switch orchestrator… (before: the header's Switch pill)",
    modes: ["dark"],
    open: async (page) => {
      await openOverviewHome(page, 1440, { panel: false });
      await page.getByTestId("pane-header").getByRole("button", { name: "Thread menu" }).click();
      await page.getByTestId("thread-menu").waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "views-orchestrator-home",
    title: "The asks scenario's orchestrator in the Orchestrator layout",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateAsks());
    },
  },
  {
    name: "views-switcher",
    title: "The workspace switcher open: asks per workspace, ⌘1–⌘9, then solo threads",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateAsks());
      await page.getByTestId("workspace-switcher-button").click();
      await page.getByTestId("solo-threads").waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "views-layout-picker",
    title: "The layout picker open: the six presets",
    open: async (page) => {
      await openOrchestratorOf(page, () => window.gramMock!.simulateAsks());
      await page.getByRole("button", { name: /^Layout: / }).click();
      await page.getByRole("radiogroup", { name: "Layout" }).waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "home-with-workspace",
    title: "The home page once a workspace exists: no welcome card",
    open: async (page) => {
      await seedMockSettings(page, { onboarding: { welcomeSeen: false } });
      await page.goto("/");
      await page.getByTestId("welcome").waitFor();
      await page.evaluate(async () => {
        if (!(await window.gramMock?.simulateOrchestration("board"))) {
          throw new Error("the mock API isn't on this page");
        }
      });
      await page.getByTestId("overview-workspace").first().waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "launch-orchestrator",
    title: "A launch with a workspace, landed on its orchestrator",
    open: async (page) => {
      await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "board"));
      await page.goto("/");
      await page.waitForURL(/\/t\/t-mock-\d+$/);
      await page.getByTestId("transcript").waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "settings-gateways",
    title: "Settings → Gateways, with Show dollar cost under Cost",
    open: async (page) => {
      await page.goto("/settings/gateways");
      await page.getByText(/^Optional: local agents use/).waitFor();
    },
  },
  {
    name: "settings-change-card",
    title: "An agent's proposed settings change, as before → after, waiting for Apply changes",
    open: async (page) => {
      await page.goto("/t/t-release");
      const composer = page.getByLabel("Message", { exact: true });
      await composer.fill("Please change the workspace settings");
      await composer.press("Enter");
      await page.getByTestId("settings-diff").waitFor();
    },
    element: (page) => page.getByTestId("approval-card"),
  },
  {
    name: "worker-report",
    title: "A worker's report card, naming the orchestrator it went to",
    modes: ["dark"],
    open: async (page) => {
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      const made = await page.evaluate(async () => {
        const scenario = await window.gramMock?.simulateOrchestration();
        if (!scenario) throw new Error("the mock API isn't on this page");
        return scenario;
      });
      // In the app rather than by URL: a reload would drop the mock's simulated workspace.
      await openOrchestrator(page, made.orchestratorThreadId);
      await threadRow(page, made.workerThreadId).click();
      await page.getByTestId("worker-report").waitFor();
    },
    element: (page) => page.getByTestId("worker-report"),
  },
  {
    name: "worker-view-held",
    title: "A worker you hold: its header, and how it says so",
    open: async (page) => {
      await followColorScheme(page);
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      const made = await page.evaluate(async () => {
        const scenario = await window.gramMock?.simulateOrchestration("board");
        if (!scenario) throw new Error("the mock API isn't on this page");
        return scenario;
      });
      // In the app rather than by URL: a reload would drop the mock's simulated workspace.
      await openOrchestrator(page, made.orchestratorThreadId);
      await threadRow(page, made.working).click();
      await expect(page.getByTestId("pane-header")).toContainText("Mail trigger queue worker");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "workers-list",
    title: "⌘J: every worker of the workspace, Now tab",
    open: async (page) => {
      await openWorkersScenario(page);
      await pressWorkersList(page);
      await page.getByTestId("worker-row").first().waitFor();
    },
  },
  {
    name: "workers-list-earlier",
    title: "⌘J scrolled to Earlier, with its search",
    modes: ["dark"],
    open: async (page) => {
      await openWorkersScenario(page);
      await pressWorkersList(page);
      await page.getByTestId("workers-section-earlier").scrollIntoViewIfNeeded();
      await page.getByTestId("workers-search").waitFor();
    },
    element: (page) => page.getByTestId("workers-list"),
  },
  {
    name: "worker-view-live",
    title: "A live worker opened from ⌘J: crumbs, catch-up and Following live",
    open: async (page) => {
      const made = await openWorkersScenario(page);
      await pressWorkersList(page);
      await page.getByTestId("workers-list").locator(`[data-thread-id="${made.live}"]`).click();
      await page.evaluate((id) => {
        window.gramMock!.simulateChunks(id as never, "shot-live" as never, [
          { type: "start", messageId: "shot-live" },
          { type: "text-start", id: "shot-live-text" },
          { type: "text-delta", id: "shot-live-text", delta: "40 of 52 pass so far." },
        ]);
      }, made.live);
      await expect(page.getByTestId("worker-catch-up")).toHaveAttribute("data-source", "helper");
      await page.getByTestId("following-live").waitFor();
    },
  },
  {
    name: "first-run",
    title: "First run: pick a repository, with the tools beside it",
    open: async (page) => {
      await seedMockSettings(page, {
        appearance: { mode: "system" },
        onboarding: { welcomeSeen: false },
      });
      // Codex alone, signed in: set here, never the machine's own CLIs.
      await page.addInitScript(() =>
        sessionStorage.setItem(
          "gram.mock.launchChecks",
          JSON.stringify({
            tools: [
              { tool: "codex", found: true, version: "0.160.0" },
              { tool: "git", found: true, version: "2.47.1" },
              { tool: "gh", found: true, version: "2.63.0" },
            ],
            claudeSignIn: "notSignedIn",
            codexSignIn: "signedIn",
            ghSignedIn: true,
            localAgentsInUse: ["codex"],
          }),
        ),
      );
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/");
      await page.getByTestId("welcome").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "new-workspace",
    title: "New workspace: repos, what it should work on, and autonomy",
    open: async (page) => {
      await seedMockSettings(page, { appearance: { mode: "system" } });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/new-workspace?repo=p-api");
      await page.getByTestId("new-workspace").waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "worker-header-actions",
    title: "A worker's header: Keep beside and Take over beside its crumbs",
    open: async (page) => {
      const made = await openReachingScenario(page);
      await pressWorkersList(page);
      await page.getByTestId("workers-list").locator(`[data-thread-id="${made.asking}"]`).click();
      await page.getByTestId("worker-crumbs").waitFor();
    },
    element: (page) => page.getByTestId("pane-header").first(),
  },
  {
    name: "keep-beside",
    title: "⌘\\ on a worker: kept beside the orchestrator's chat (before: the grid split)",
    open: async (page) => {
      const made = await openReachingScenario(page);
      await pressWorkersList(page);
      await page.getByTestId("workers-list").locator(`[data-thread-id="${made.live}"]`).click();
      await page.getByTestId("worker-crumbs").waitFor();
      await page.keyboard.press("ControlOrMeta+Backslash");
      await page.waitForTimeout(600);
    },
  },
  {
    name: "workers-list-done-today",
    title: "⌘J's Done today, with a worker whose worktree was cleaned up",
    modes: ["dark"],
    open: async (page) => {
      await openReachingScenario(page);
      await pressWorkersList(page);
      await page.getByTestId("workers-section-doneToday").scrollIntoViewIfNeeded();
    },
    element: (page) => page.getByTestId("workers-list"),
  },
  {
    name: "finished-worker",
    title: "A cleaned-up worker, read-only, with Ask about it",
    open: async (page) => {
      const made = await openReachingScenario(page, { reaching: true });
      await pressWorkersList(page);
      await page
        .getByTestId("workers-list")
        .locator(`[data-thread-id="${made.cleanedUp}"]`)
        .click();
      await page.getByTestId("finished-worker").waitFor();
    },
  },
  {
    name: "worker-stuck",
    title: "Why is it stuck? on a worker idle two hours, with its nudges",
    open: async (page) => {
      const made = await openReachingScenario(page, { reaching: true });
      await pressWorkersList(page);
      await page.getByTestId("workers-list").locator(`[data-thread-id="${made.stuck}"]`).click();
      await expect(page.getByTestId("worker-stuck")).toHaveAttribute("data-source", "helper");
    },
  },
  {
    name: "new-workspace-repos-loading",
    title: "New workspace's repository field while GitHub's repositories load",
    open: async (page) => {
      // Suggestions that never come, so the shot holds the wait a large organisation's first list
      // takes. Wrapped as the mock is assigned, before the sheet asks for them.
      await page.addInitScript(() => {
        let mock: unknown;
        Object.defineProperty(window, "gramMock", {
          configurable: true,
          get: () => mock,
          set: (value: { cloneSuggestions: () => Promise<unknown> }) => {
            value.cloneSuggestions = () => new Promise(() => {});
            mock = value;
          },
        });
      });
      await page.goto("/new-workspace");
      await page.getByRole("form", { name: "New workspace" }).waitFor();
      await page.getByRole("combobox", { name: "Folder, GitHub repo or URL" }).click();
    },
    element: (page) => page.getByTestId("add-repository"),
  },
  {
    name: "orchestrator-briefing",
    title: "A message to the orchestrator, briefing… until its feature card arrives",
    open: async (page) => {
      // Holds the orchestrator's turn while it reads, where the base just answers.
      await page.addInitScript(() => {
        window.gramMockHoldGates = true;
      });
      await openOrchestratorOf(page, async () => {
        const mock = window.gramMock!;
        const state = await mock.saveWorkspace({
          name: "agent-platform",
          projectIds: ["p-api", "p-web"] as never,
          homeProjectId: "p-api" as never,
        });
        const thread = await mock.startTask({
          target: { workspaceId: state.workspace.id },
          input: { text: "Add paging to the registry list in web. Wait for the API first." },
        });
        return { orchestratorThreadId: thread.id };
      });
    },
  },
  {
    name: "settings-workspaces",
    title: "Settings → Workspaces with three workspaces",
    modes: ["dark"],
    open: async (page) => {
      await openWorkspaceSettings(page);
      await fitSettings(page);
    },
  },
  {
    name: "settings-notifications",
    title: "Settings → Notifications: actions in notifications and muted workspaces",
    modes: ["dark"],
    open: async (page) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/settings/notifications");
      await page.waitForFunction(() => window.gramMock !== undefined);
      // In the page rather than by URL: a reload would drop the seeded workspaces.
      await page.evaluate(() => window.gramMock!.seedSidebarLoad());
      await page.getByTestId("notification-settings").waitFor();
      await fitSettings(page);
    },
  },
  {
    name: "settings-workspace-page",
    title: "One workspace's settings, Advanced open",
    modes: ["dark"],
    open: async (page) => {
      await openWorkspaceSettings(page);
      await page
        .getByRole("listitem", { name: "Workspace agent-platform" })
        .getByTestId("workspace-link")
        .click();
      await page.getByTestId("workspace-advanced").click();
      await fitSettings(page);
    },
  },
  {
    name: "menu-thread",
    title: "A plain thread's row menu",
    open: async (page) => {
      await openBoardSidebar(page);
      await rowMenu(page, threadRow(page, "t-flaky"));
    },
    element: (page) => page.getByRole("menu"),
  },
  {
    name: "menu-worker",
    title: "A held worker's row menu",
    open: async (page) => {
      const made = await openBoardSidebar(page);
      await rowMenu(page, threadRow(page, made.working));
    },
    element: (page) => page.getByRole("menu"),
  },
  {
    name: "palette-commands",
    title: "⌘K command mode (>) on a thread",
    open: async (page) => {
      await openBoardSidebar(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("command-palette").getByRole("combobox").fill(">");
      await page.waitForTimeout(300);
    },
    element: (page) => page.getByTestId("command-palette"),
  },
  {
    name: "palette-in-words",
    title: "Go to in words: workers waiting on me",
    open: async (page) => {
      await openBoardSidebar(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("command-palette").getByRole("combobox").fill("workers waiting on me");
      // Both heads search the same literal sentence; only the after head understands its filters.
      await page.getByTestId("command-palette").getByRole("combobox").blur();
    },
    element: (page) => page.getByTestId("command-palette"),
  },
  {
    name: "palette-go-to",
    title: "⌘K go to, before typing",
    open: async (page) => {
      await openBoardSidebar(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("command-palette").getByRole("option").first().waitFor();
      await page.waitForTimeout(300);
    },
    element: (page) => page.getByTestId("command-palette"),
  },
  {
    name: "palette-more-worker",
    title: "More… on a worker: ⌘K scoped to it",
    open: async (page) => {
      const made = await openBoardSidebar(page);
      await rowMenu(page, threadRow(page, made.working));
      await page.getByRole("menuitem", { name: "More…" }).click();
      await page.getByTestId("palette-scope").waitFor();
      await page.waitForTimeout(300);
    },
    element: (page) => page.getByTestId("command-palette"),
  },
];

/**
 * A shot that loads `path` and waits for the shell and the network to settle, for `--path`. Named
 * after the path: `/settings/agents` is `settings-agents`, `/` is `home`.
 */
export function pathShot(path: string): Shot {
  const name =
    path
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "home";
  return {
    name,
    title: `\`${path}\``,
    open: async (page) => {
      await page.goto(path);
      await page.getByTestId("app-shell").waitFor();
      await page.waitForLoadState("networkidle");
    },
  };
}
