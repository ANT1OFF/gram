import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { startHarness, type Harness } from "./harness";
import { threadRow } from "../e2e/thread-row";

// What switching threads asks of the real server: the RPCs each switch sends and the
// `git` processes they start, beside the renderer's time to paint. Echo-agent threads in worktrees
// of the harness repo, one with a PR. Opt in with GRAM_PERF_SWITCH=1; `GRAM_PERF_OUT` names the
// results file, `GRAM_PERF_THREADS` and `GRAM_PERF_TURNS` the shape.
const PERF = process.env["GRAM_PERF_SWITCH"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-switch.md");
const THREADS = Number(process.env["GRAM_PERF_THREADS"] ?? 6);
const TURNS = Number(process.env["GRAM_PERF_TURNS"] ?? 8);

test.skip(!PERF, "set GRAM_PERF_SWITCH=1 to measure thread switches on the real server");
test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

const results: Array<[string, string]> = [];
const record = (metric: string, value: string) => {
  results.push([metric, value]);
  console.log(`${metric}: ${value}`);
};
const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const commandLog = join(tmpdir(), `gram-perf-switch-commands-${process.pid}.log`);
let h: Harness;
let page: Page;
let cdp: CDPSession;
const threads: string[] = [];
/** RPC tags the page has sent since the last `takeRpcs`. */
let sent: string[] = [];

test.beforeAll(async ({ browser }) => {
  writeFileSync(commandLog, "");
  // The real sweep's git runs would drown what a switch starts; the watcher still refreshes.
  h = await startHarness({ commandLog, env: { GRAM_GIT_SWEEP_MS: "3600000" } });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      for (const match of text.matchAll(/"_tag":"Request","id":[^,]*,"tag":"([\w.]+)"/g)) {
        sent.push(match[1]!);
      }
    });
  });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
});

test.afterAll(async () => {
  await page?.close();
  await h?.stop();
  if (!PERF || results.length === 0) return;
  const lines = [
    "| Metric | Value |",
    "| --- | --- |",
    ...results.map(([metric, value]) => `| ${metric} | ${value} |`),
  ];
  writeFileSync(OUT_FILE, `${lines.join("\n")}\n`);
  console.log(`results written to ${OUT_FILE}`);
});

const takeRpcs = () => {
  const out = sent;
  sent = [];
  return out;
};
let logged = 0;
/** The `git` and `gh` command lines the server has run since the last call. */
const takeCommands = () => {
  const lines = readFileSync(commandLog, "utf8").split("\n").filter(Boolean);
  const out = lines.slice(logged);
  logged = lines.length;
  return out;
};

/** `tag ×n` for each tag, most frequent first. */
const tally = (tags: readonly string[]) =>
  [...Map.groupBy(tags, (t) => t)]
    .toSorted((a, b) => b[1].length - a[1].length)
    .map(([tag, all]) => `${tag} ×${all.length}`)
    .join(", ");

/** `git status`, `gh pr view`: a logged command line's program and subcommand, past `-C` and `-c`. */
const subcommand = (line: string) => {
  const words = line.split(" ");
  if (words[0] === "gh") return words.slice(0, 3).join(" ");
  for (let i = 1; i < words.length; i++) {
    if (words[i] === "-C" || words[i] === "-c") i++;
    else if (!words[i]!.startsWith("-")) return `${words[0]} ${words[i]}`;
  }
  return "?";
};

const send = async (prompt: string) => {
  const composer = page.getByRole("combobox", { name: "Message" });
  await composer.fill(prompt);
  await composer.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("transcript").getByText(`echo: ${prompt}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("transcript").locator('[data-streaming="true"]')).toHaveCount(0);
};

test("seed threads with finished turns, one with a PR", async () => {
  for (let t = 0; t < THREADS; t++) {
    await h.open(page, "/new");
    await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
    await expect(page.getByTestId("folder-status")).toBeVisible();
    await page
      .getByRole("radiogroup", { name: "Checkout" })
      .getByRole("radio", { name: "New worktree" })
      .click();
    await page.getByRole("textbox", { name: "Branch name" }).fill(`perf-${t}`);
    await page.getByRole("combobox", { name: "First prompt" }).fill(`thread ${t} turn 0`);
    await page.getByRole("button", { name: "Create thread" }).click();
    await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
    threads.push(new URL(page.url()).pathname.split("/").at(-1)!);
    await expect(page.getByText(`echo: thread ${t} turn 0`)).toBeVisible({ timeout: 30_000 });
    for (let turn = 1; turn < TURNS; turn++) await send(`thread ${t} turn ${turn}`);
  }

  const worktree = h.worktreeOnBranch("perf-0");
  writeFileSync(join(worktree, "perf.md"), "A change to open a PR for.\n");
  h.git(worktree, "add", "-A");
  h.git(worktree, "commit", "-qm", "Add a perf note");
  await threadRow(page, threads[0]!).click();
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await panel.getByTestId("push-button").click();
  await expect(panel.getByTestId("push-button")).toBeHidden();
  await panel.getByTestId("create-pr-button").click();
  await page.getByTestId("create-pr-dialog").getByRole("button", { name: "Create PR" }).click();
  await expect(page.getByTestId("pane-pr-badge")).toContainText("#1");
});

/** Opens `threadId` from the sidebar and returns the time until its transcript has painted. */
const openThread = async (threadId: string) => {
  const started = Date.now();
  await threadRow(page, threadId).click();
  await expect(page.getByTestId("pane").first()).toHaveAttribute("data-thread-id", threadId);
  await expect(page.getByTestId("transcript").getByTestId("message-assistant").first()).toBeVisible(
    { timeout: 30_000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return Date.now() - started;
};

const busy = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
};

/** Switches through every thread twice and records each pass; the second finds feeds and queries warm. */
const cycle = async (label: string) => {
  // Settle what the last step started, so the first switch is charged only its own requests.
  await page.waitForTimeout(3_000);
  takeRpcs();
  takeCommands();
  for (const pass of ["", " again"]) {
    const times: number[] = [];
    const rpcs: string[] = [];
    const commands: string[] = [];
    const before = await busy();
    const started = Date.now();
    for (const id of [...threads.slice(1), threads[0]!]) {
      times.push(await openThread(id));
      // Queries a switch starts land within a few hundred ms; wait them out before the next one.
      await page.waitForTimeout(1_500);
      rpcs.push(...takeRpcs());
      commands.push(...takeCommands());
    }
    const seconds = (Date.now() - started) / 1000;
    const n = threads.length;
    record(
      `${label}, switching${pass}: paint`,
      `median ${median(times)} ms, longest ${Math.max(...times)} ms; main thread ${round((((await busy()) - before) / seconds) * 100)}% busy over ${round(seconds)} s`,
    );
    record(
      `${label}, switching${pass}: RPCs per switch`,
      `${round(rpcs.length / n)} (${tally(rpcs)})`,
    );
    record(
      `${label}, switching${pass}: git and gh processes per switch`,
      `${round(commands.length / n)} (${tally(commands.map(subcommand))})`,
    );
  }
};

test("switch with the right panel on Diff, on PR, and closed", async () => {
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Diff", exact: true }).click();
  await cycle("Diff panel open");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await cycle("PR panel open");
  await page.keyboard.press("ControlOrMeta+Alt+KeyB");
  await expect(panel).toBeHidden();
  await cycle("right panel closed");
});
