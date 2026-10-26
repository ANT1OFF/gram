import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { startHarness, type Harness } from "./harness";
import { threadRow } from "../e2e/thread-row";

// What an idle app costs on the real server (the performance pass): echo-agent threads in
// worktrees of the harness repo, some with open PRs, at the production git sweep cadence. With the
// window open on a thread and nobody touching it, then with no window at all, it records the
// server's CPU and memory, the `git` and `gh` processes it starts and what it pushes over the
// socket. Opt in with GRAM_PERF_IDLE=1; `GRAM_PERF_OUT` names the results file, `GRAM_PERF_THREADS`,
// `GRAM_PERF_PRS` and `GRAM_PERF_IDLE_SECONDS` the shape.
const PERF = process.env["GRAM_PERF_IDLE"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-idle.md");
const THREADS = Number(process.env["GRAM_PERF_THREADS"] ?? 8);
const PRS = Number(process.env["GRAM_PERF_PRS"] ?? 4);
const TURNS = 3;
const IDLE_MS = Number(process.env["GRAM_PERF_IDLE_SECONDS"] ?? 120) * 1000;

test.skip(!PERF, "set GRAM_PERF_IDLE=1 to measure the idle real server");
test.describe.configure({ mode: "serial" });
test.setTimeout(1_800_000);

const results: Array<[string, string]> = [];
const record = (metric: string, value: string) => {
  results.push([metric, value]);
  console.log(`${metric}: ${value}`);
};
const round = (n: number, digits = 1) => Number(n.toFixed(digits));

const commandLog = join(tmpdir(), `gram-perf-idle-commands-${process.pid}.log`);
let h: Harness;
let page: Page;
let cdp: CDPSession;
const threads: string[] = [];
/** Frames the page received since the last `takeFrames`, by bytes. */
let received: string[] = [];

test.beforeAll(async ({ browser }) => {
  writeFileSync(commandLog, "");
  // Production cadences, not the harness's fast test timers.
  h = await startHarness({
    commandLog,
    env: {
      GRAM_GIT_SWEEP_MS: "15000",
      GRAM_GIT_SETTLE_MS: "30000",
      GRAM_BABYSIT_QUIET_MS: "600000",
      GRAM_REVIEW_DEBOUNCE_MS: "10000",
    },
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      received.push(typeof payload === "string" ? payload : payload.toString("utf8"));
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

const takeFrames = () => {
  const out = received;
  received = [];
  return out;
};
let logged = 0;
const takeCommands = () => {
  const lines = readFileSync(commandLog, "utf8").split("\n").filter(Boolean);
  const out = lines.slice(logged);
  logged = lines.length;
  return out;
};

/** `tag ×n` for each tag, most frequent first. */
const tally = (tags: readonly string[], top = 12) =>
  [...Map.groupBy(tags, (t) => t)]
    .toSorted((a, b) => b[1].length - a[1].length)
    .slice(0, top)
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

/** The event kinds a received frame carries: each `"type":"…"` at the start of a pushed value. */
const kinds = (frame: string) =>
  [...frame.matchAll(/\{"type":"([\w.-]+)"/g)].map((m) => m[1]!).slice(0, 1);

/** CPU seconds and RSS of the server process (children are short-lived and counted separately). */
const serverSample = () => {
  const pid = h.pid();
  if (pid === undefined) return { cpu: 0, rssMb: 0 };
  const [time = "0:0", rss = "0"] = execFileSync(
    "/bin/ps",
    ["-o", "time=,rss=", "-p", String(pid)],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split(/\s+/);
  const parts = time.split(":").map(Number);
  const cpu = parts.reduce((total, part) => total * 60 + part, 0);
  return { cpu, rssMb: Number(rss) / 1024 };
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

test("seed worktree threads with finished turns, some with PRs", async () => {
  const booted = serverSample();
  record("server RSS after boot, empty profile", `${round(booted.rssMb)} MB`);
  for (let t = 0; t < THREADS; t++) {
    await h.open(page, "/new");
    await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
    await expect(page.getByTestId("folder-status")).toBeVisible();
    await page
      .getByRole("radiogroup", { name: "Checkout" })
      .getByRole("radio", { name: "New worktree" })
      .click();
    await page.getByRole("textbox", { name: "Branch name" }).fill(`idle-${t}`);
    await page.getByRole("combobox", { name: "First prompt" }).fill(`thread ${t} turn 0`);
    await page.getByRole("button", { name: "Create thread" }).click();
    await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
    threads.push(new URL(page.url()).pathname.split("/").at(-1)!);
    await expect(page.getByText(`echo: thread ${t} turn 0`)).toBeVisible({ timeout: 30_000 });
    for (let turn = 1; turn < TURNS; turn++) await send(`thread ${t} turn ${turn}`);
  }
  for (let t = 0; t < PRS; t++) {
    const worktree = h.worktreeOnBranch(`idle-${t}`);
    writeFileSync(join(worktree, `idle-${t}.md`), "A change to open a PR for.\n");
    h.git(worktree, "add", "-A");
    h.git(worktree, "commit", "-qm", `Add idle note ${t}`);
    await threadRow(page, threads[t]!).click();
    const panel = page.getByTestId("right-panel");
    if (!(await panel.isVisible())) await page.keyboard.press("ControlOrMeta+Alt+KeyB");
    await panel.getByRole("tab", { name: "PR", exact: true }).click();
    await panel.getByTestId("push-button").click();
    await expect(panel.getByTestId("push-button")).toBeHidden();
    await panel.getByTestId("create-pr-button").click();
    await page.getByTestId("create-pr-dialog").getByRole("button", { name: "Create PR" }).click();
    await expect(page.getByTestId("pane-pr-badge")).toContainText(`#${t + 1}`);
  }
  // Half the PRs wait on CI, so their watches stay hot; the rest have settled green.
  for (const pr of h.prs()) h.setChecks(pr.number, pr.number % 2 === 0 ? "passing" : "pending");
  const seeded = serverSample();
  record(
    "seeded",
    `${THREADS} worktree threads × ${TURNS} turns, ${PRS} open PRs (half pending CI); server RSS ${round(seeded.rssMb)} MB`,
  );
});

/** Idles for `IDLE_MS` and records the server's cost and what it sent, per minute. */
const idle = async (label: string) => {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  takeFrames();
  takeCommands();
  const before = serverSample();
  const busyBefore = page.isClosed()
    ? 0
    : ((await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")
        ?.value ?? 0);
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  const seconds = (Date.now() - started) / 1000;
  const after = serverSample();
  const minutes = seconds / 60;
  const commands = takeCommands();
  appendFileSync(`${OUT_FILE}.commands.txt`, `## ${label}\n${commands.join("\n")}\n`);
  const frames = takeFrames();
  const bytes = frames.reduce((total, frame) => total + frame.length, 0);
  record(
    `${label}: server CPU`,
    `${round(((after.cpu - before.cpu) / seconds) * 100, 2)}% of a core over ${round(seconds)} s; RSS ${round(before.rssMb)} → ${round(after.rssMb)} MB`,
  );
  record(
    `${label}: git and gh processes per minute`,
    `${round(commands.length / minutes)} (${tally(commands.map(subcommand))})`,
  );
  if (!page.isClosed()) {
    const busyAfter =
      (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")
        ?.value ?? 0;
    record(
      `${label}: socket frames received per minute`,
      `${round(frames.length / minutes)} frames, ${round(bytes / 1024 / minutes)} KiB (${tally(frames.flatMap(kinds))}); renderer main thread ${round(((busyAfter - busyBefore) / seconds) * 100, 2)}% busy`,
    );
    const largest = frames.toSorted((a, b) => b.length - a.length)[0];
    if (largest) {
      record(
        `${label}: largest frame`,
        `${round(largest.length / 1024)} KiB (${kinds(largest).join(", ") || largest.slice(0, 60)})`,
      );
    }
  }
};

test("idle with a thread open", async () => {
  await threadRow(page, threads[0]!).click();
  await expect(page.getByTestId("pane").first()).toHaveAttribute("data-thread-id", threads[0]!);
  await idle("window open, thread with a PR");
});

test("idle with no window", async () => {
  await page.close();
  await idle("no window");
});
