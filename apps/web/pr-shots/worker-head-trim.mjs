// PROTOTYPE ONLY (worker-head-trim, round 1): shoots the right pane's worker head in today's form
// and each variant, on the mock's board scenario, for a blind rating. Needs the mock dev server
// (`VITE_API=mock vite`) at BASE.
//
//   node apps/web/pr-shots/worker-head-trim.mjs <outDir> [variant ...]
//
// Each shot is `<variant>-<state>-<scheme>-<width>.png`.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:5391";
const [outDir, ...picked] = process.argv.slice(2);
if (outDir === undefined) throw new Error("usage: worker-head-trim.mjs <outDir> [variant ...]");
const VARIANTS = picked.length > 0 ? picked : ["before", "v1", "v2", "v3"];
const SCHEMES = ["light", "dark"];
/** Desktop: the pane dragged wide, as in the screenshot that asked for this; narrow: its 480 px least. */
const WIDTHS = {
  desktop: { width: 1600, height: 900, widen: 300 },
  narrow: { width: 1280, height: 900, widen: 0 },
};

const step = (id, text, status, source = "agent") => ({
  id,
  text,
  status,
  source,
});

/** The synthetic plans: one short, one as long as the screenshot that asked for this. */
const PLANS = {
  short: {
    goal: "Queue worker that delivers mail triggers, with retries",
    steps: [
      step("s1", "Queue consumer and its schema", "done"),
      step("s2", "Retries with backoff", "done"),
      step("s3", "Run the queue suite and fix what fails", "doing"),
      step("s4", "Open the PR and get CI green", "todo"),
    ],
  },
  long: {
    goal: 'Build the "Mail trigger" endpoint across the api, web and docs repos',
    steps: [
      step("s1", "Agree the trigger contract", "done", "orchestrator"),
      step("s2", "Endpoint and schema in api", "done"),
      step("s3", "Client in web", "done"),
      step("s4", "Docs page", "done"),
      step("s5", "Wire retries and idempotency keys", "done"),
      step("s6", "Review fixes from round 1", "done"),
      step("s7", "Second review round", "done"),
      step("s8", "Focused checks, before/after shots", "doing"),
    ],
  },
};

/** The states each option is shot in: which worker, and what plan it keeps. */
const STATES = {
  "one-repo-plan": { worker: "working", plan: "short" },
  "multi-repo": { worker: "inReview", plan: undefined },
  "multi-repo-plan": { worker: "inReview", plan: "long" },
};

const shoot = async (browser, variant, stateName, scheme, widthName) => {
  const state = STATES[stateName];
  const context = await browser.newContext({
    viewport: {
      width: WIDTHS[widthName].width,
      height: WIDTHS[widthName].height,
    },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.addInitScript(
    (args) => {
      sessionStorage.setItem("gram.dev.workerHead", args.variant);
      const key = "gram.mock.settings";
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      saved.appearance = { ...saved.appearance, mode: args.scheme };
      sessionStorage.setItem(key, JSON.stringify(saved));
    },
    { variant, scheme },
  );
  await page.goto(`${BASE}/t/t-flaky`);
  await page.getByTestId("app-shell").waitFor();
  await page.getByTestId("overview-sidebar").waitFor();
  const made = await page.evaluate(() => window.gramMock.simulateOrchestration("board"));
  const worker = made[state.worker];
  const plan = state.plan === undefined ? undefined : PLANS[state.plan];
  await page.evaluate(
    (args) => {
      const mock = window.gramMock;
      if (args.plan !== undefined) {
        mock.simulatePlan(args.worker, {
          ...args.plan,
          basis: "shots",
          updatedAt: Date.now() - 4 * 60_000,
          updatedBy: "helper",
        });
      }
      mock.simulateStatus(args.worker, "running", "Running bun run --filter @gram/web e2e");
    },
    { worker, plan },
  );
  // The orchestrator, from its workspace's row; then the overview hidden, as in the screenshot.
  const workspaceId = await page.evaluate(
    async (id) =>
      (await window.gramMock.listWorkspaces()).find((s) => s.workspace.orchestratorThreadId === id)
        ?.workspace.id,
    made.orchestratorThreadId,
  );
  await page
    .locator(
      `[data-testid="overview-workspace"][data-workspace-id="${workspaceId}"] [data-testid="overview-workspace-row"]`,
    )
    .click();
  await page.waitForURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await page.getByTestId("overview-hide").click();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await page.getByTestId("workers-panel").waitFor();
  await page
    .locator(`[data-testid="workers-panel-row"][data-thread-id="${worker}"]`)
    .first()
    .click();
  const pane = page.getByTestId("beside-dock");
  await pane.getByTestId("worker-pane-head").waitFor();
  if (WIDTHS[widthName].widen > 0) {
    const grip = await page.getByTestId("right-resize").boundingBox();
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - WIDTHS[widthName].widen, y, { steps: 8 });
    await page.mouse.up();
  }
  // The keys off the title, so no focus ring is in the shot.
  await page.mouse.click(5, WIDTHS[widthName].height - 5);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
  const box = await pane.boundingBox();
  const file = join(outDir, `${variant}-${stateName}-${scheme}-${widthName}.png`);
  await page.screenshot({
    path: file,
    clip: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: Math.min(box.height, 300),
    },
  });
  console.log(file, Math.round(box.width));
  // Where the rows' words went: the plan opened, and the multi-repo caveat shown.
  if (stateName === "multi-repo-plan" && widthName === "desktop") {
    const tall = {
      x: box.x,
      y: box.y,
      width: box.width,
      height: Math.min(box.height, 560),
    };
    const trigger =
      variant === "before"
        ? page.locator(`[data-testid="plan-strip"] > button`).first()
        : page.getByTestId("worker-head-plan").first();
    await trigger.click();
    await page.waitForTimeout(500);
    await page.mouse.move(2, 2);
    const opened = join(outDir, `${variant}-plan-opened-${scheme}-${widthName}.png`);
    await page.screenshot({ path: opened, clip: tall });
    console.log(opened);
    // Closed as it opened: Esc in the pane goes back to the Workers list.
    await trigger.click();
    await page.waitForTimeout(300);
    const caveat =
      variant === "before"
        ? page.getByTestId("worker-banner-repos").first()
        : variant === "v1"
          ? page.getByTestId("beside-tab-changes")
          : page.getByTestId("worker-head-repos").first();
    await caveat.hover();
    await page.waitForTimeout(600);
    const shown = join(outDir, `${variant}-repos-shown-${scheme}-${widthName}.png`);
    await page.screenshot({ path: shown, clip: tall });
    console.log(shown);
  }
  await context.close();
};

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const variant of VARIANTS)
    for (const stateName of Object.keys(STATES))
      for (const scheme of SCHEMES)
        for (const widthName of Object.keys(WIDTHS))
          await shoot(browser, variant, stateName, scheme, widthName);
} finally {
  await browser.close();
}
