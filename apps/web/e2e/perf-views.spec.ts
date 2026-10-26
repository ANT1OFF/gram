import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { threadRow } from "./thread-row";

// The heavier views under a working app (the performance pass): a reply streaming into a long
// thread, the Board with many workers, the Usage page and the needs-you popover, on the mock API
// with threads streaming in the background. Opt in with GRAM_PERF_VIEWS=1; `GRAM_PERF_OUT` names the
// results file. Each scenario records the main thread's busy share, React commits, long tasks and
// frame pacing; on a development build (`GRAM_E2E_SERVER=dev`) `GRAM_PERF_PROFILE=1` adds renders by
// component. Timings belong to the production bundle (`GRAM_E2E_SERVER=preview`, the default).
const PERF = process.env["GRAM_PERF_VIEWS"] === "1";
const PROFILE = process.env["GRAM_PERF_PROFILE"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-views-web.md");
const WINDOW_MS = 8_000;
/** Components whose render counts the profile always reports, outside the top twelve or not. */
const TRACKED = [
  "DiffPanel",
  "DiffBody",
  "DiffTree",
  "DiffFileRow",
  "MessageBlock",
  "ToolCard",
  "TaskCard",
  "Transcript",
  // The always-mounted views that server events and thread changes reach.
  "RailBoard",
  "FeatureLine",
  "WorkerChip",
  "BoardHeader",
  "AskStack",
  "WorkersButton",
  "OverviewDoneToday",
  "NeedsYouShortcut",
  "NeedsYou",
  "AwayNotifications",
  "MenuBarAsks",
];

test.skip(!PERF, "set GRAM_PERF_VIEWS=1 to measure the heavier views");
test.setTimeout(600_000);

const results: Array<[string, string]> = [];
const record = (metric: string, value: string) => {
  results.push([metric, value]);
  console.log(`${metric}: ${value}`);
};
const round = (n: number, digits = 1) => Number(n.toFixed(digits));

interface ViewPerf {
  commits: number;
  renders: Record<string, { count: number; ms: number }>;
  longTasks: number[];
  frames: number[];
}
type PerfWindow = Window & { gramViewPerf: ViewPerf };

/** React commits (and, on a development build, renders by component), long tasks and frame gaps. */
const instrument = (page: Page) =>
  page.addInitScript((attribute) => {
    const perf: ViewPerf = { commits: 0, renders: {}, longTasks: [], frames: [] };
    (window as unknown as PerfWindow).gramViewPerf = perf;
    const HOOK = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
    const globals = window as unknown as Record<string, object | undefined>;
    let renderers = 0;
    interface Fiber {
      type: unknown;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      actualDuration?: number;
      actualStartTime?: number;
    }
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- serialized with the script
    const rendered = (fiber: Fiber) =>
      (fiber.actualDuration ?? 0) > 0 &&
      (fiber.alternate === null || fiber.alternate.actualStartTime !== fiber.actualStartTime);
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- serialized with the script
    const nameOf = (type: unknown): string | undefined => {
      if (typeof type === "function") return type.name || undefined;
      if (typeof type !== "object" || type === null) return undefined;
      const wrapped = type as { displayName?: string; render?: unknown; type?: unknown };
      return wrapped.displayName ?? nameOf(wrapped.render ?? wrapped.type);
    };
    const walk = (fiber: Fiber) => {
      if (!rendered(fiber)) return;
      let children = 0;
      for (let child = fiber.child; child !== null; child = child.sibling) {
        if (rendered(child)) children += child.actualDuration ?? 0;
        walk(child);
      }
      const name = nameOf(fiber.type);
      if (name === undefined) return;
      const entry = (perf.renders[name] ??= { count: 0, ms: 0 });
      entry.count++;
      entry.ms += Math.max(0, (fiber.actualDuration ?? 0) - children);
    };
    globals[HOOK] = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => ++renderers,
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      checkDCE: () => {},
      onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
        perf.commits++;
        if (attribute) walk(root.current);
      },
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
    let last = 0;
    const frame = (now: number) => {
      if (last !== 0 && !document.hidden) perf.frames.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, PROFILE);

const take = (page: Page) =>
  page.evaluate(() => {
    const perf = (window as unknown as PerfWindow).gramViewPerf;
    const out = {
      commits: perf.commits,
      renders: perf.renders,
      longTasks: [...perf.longTasks],
      frames: [...perf.frames],
    };
    perf.commits = 0;
    perf.renders = {};
    perf.longTasks.length = 0;
    perf.frames.length = 0;
    return out;
  });

const busyMetrics = async (cdp: CDPSession) => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { task: value("TaskDuration"), script: value("ScriptDuration"), nodes: value("Nodes") };
};

const quantile = (values: readonly number[], q: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

/** Main thread, commits, long tasks and frame pacing over `ms`, or while `during` runs. */
const measure = async (page: Page, cdp: CDPSession, ms: number, during?: () => Promise<void>) => {
  await take(page);
  const before = await busyMetrics(cdp);
  const started = Date.now();
  await (during?.() ?? page.waitForTimeout(ms));
  const seconds = (Date.now() - started) / 1000;
  const after = await busyMetrics(cdp);
  const { commits, longTasks, frames, renders } = await take(page);
  const slow = frames.filter((gap) => gap > 33.4).length;
  const summary =
    `main thread ${round(((after.task - before.task) / seconds) * 100)}% busy ` +
    `(script ${round(((after.script - before.script) / seconds) * 100)}%), ` +
    `${round(commits / seconds)} commits/s, frames p50 ${round(quantile(frames, 0.5))} ms ` +
    `p95 ${round(quantile(frames, 0.95))} ms, ${slow} of ${frames.length} over 33 ms; ` +
    `long tasks ${longTasks.length}, longest ${round(Math.max(0, ...longTasks))} ms; ` +
    `${after.nodes} DOM nodes`;
  const top = Object.entries(renders)
    .toSorted((a, b) => b[1].ms - a[1].ms)
    .slice(0, 12)
    .map(([name, { count, ms: spent }]) => `${round(spent)} ms/${count}× ${name}`)
    .join(", ");
  const tracked = TRACKED.map((name) => `${renders[name]?.count ?? 0}× ${name}`).join(", ");
  return PROFILE && top ? `${summary}<br>renders: ${top}<br>tracked: ${tracked}` : summary;
};

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const goInApp = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);

const start = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await instrument(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  return cdp;
};

test("a reply streams into a long thread", async ({ page }) => {
  const cdp = await start(page);
  const [threadId] = await page.evaluate(() =>
    window.gramMock!.seedLongThreads({ count: 1, turns: 200 }),
  );
  await threadRow(page, threadId!).click();
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByTestId("message-assistant").first()).toBeVisible();
  await page.waitForTimeout(1_000);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(Array.from({ length: 600 }, (_, i) => `word${i}`).join(" "));
  record(
    "200-turn thread: a 600-word reply streams",
    await measure(page, cdp, 0, async () => {
      await composer.press("ControlOrMeta+Enter");
      await expect(transcript.locator('[data-streaming="true"]')).toBeVisible({ timeout: 10_000 });
      await expect(transcript.locator('[data-streaming="true"]')).toHaveCount(0, {
        timeout: 120_000,
      });
    }),
  );
});

test("a reply streams into a thread with subagent rows", async ({ page }) => {
  const cdp = await start(page);
  // t-flaky's scripted turn asks to push, then runs a Task with a subagent transcript.
  await threadRow(page, "t-flaky").click();
  const transcript = page.getByTestId("transcript");
  await page.getByTestId("approval-allow").click({ timeout: 60_000 });
  await expect(transcript.getByText("Find other sleep-based tests").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(transcript.getByText(/Done\. Summary/).first()).toBeVisible({ timeout: 60_000 });
  await expect(transcript.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 60_000 });
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(1_000);
  await composer.fill(Array.from({ length: 600 }, (_, i) => `word${i}`).join(" "));
  record(
    "thread with a Task row: a 600-word reply streams",
    await measure(page, cdp, 0, async () => {
      await composer.press("ControlOrMeta+Enter");
      await expect(transcript.locator('[data-streaming="true"]')).toBeVisible({ timeout: 10_000 });
      await expect(transcript.locator('[data-streaming="true"]')).toHaveCount(0, {
        timeout: 120_000,
      });
    }),
  );
});

test("the Board with 40 workers while 12 threads stream", async ({ page }) => {
  const cdp = await start(page);
  const made = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const board = await mock.simulateOrchestration("board");
    for (let i = 0; i < 32; i++) {
      await mock.simulateBrief(
        board.workspaceId,
        `feature-${i % 8}`,
        `Worker ${i} on feature ${i % 8}`,
      );
    }
    return board;
  });
  await page.evaluate(() => window.gramMock!.seedBusyThreads({ streaming: 12, idle: 20 }));
  await page.waitForTimeout(2_000);
  record(
    "sidebar with board workspace, 12 streaming: hands off",
    await measure(page, cdp, WINDOW_MS),
  );
  const opened = Date.now();
  await goInApp(page, `/t/${made.orchestratorThreadId}`);
  await page
    .getByTestId("view-switcher")
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible({ timeout: 30_000 });
  await settle(page);
  record("Board: open until painted", `${Date.now() - opened} ms`);
  await page.waitForTimeout(1_000);
  record("Board open, 12 streaming: hands off", await measure(page, cdp, WINDOW_MS));
  await page.evaluate(() => window.gramMock!.stopBusyThreads());
});

test("the Usage page", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.usage", "sample"));
  const cdp = await start(page);
  await page.evaluate(() => window.gramMock!.seedBusyThreads({ streaming: 6, idle: 0 }));
  await page.waitForTimeout(1_000);
  const opened = Date.now();
  await goInApp(page, "/usage");
  await expect(page.getByTestId("usage-overview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("usage-turns")).toBeVisible({ timeout: 30_000 });
  await settle(page);
  record("Usage: open until painted", `${Date.now() - opened} ms`);
  record("Usage open, 6 streaming: hands off", await measure(page, cdp, WINDOW_MS));
  await page.evaluate(() => window.gramMock!.stopBusyThreads());
});

test("the needs-you popover", async ({ page }) => {
  const cdp = await start(page);
  await page.evaluate(() => window.gramMock!.simulateFailures());
  await page.evaluate(() => window.gramMock!.seedBusyThreads({ streaming: 12, idle: 20 }));
  await page.waitForTimeout(2_000);
  const pill = page.getByTestId("overview-needs-you");
  await expect(pill).toBeVisible();
  const opened = Date.now();
  await pill.click();
  await expect(page.getByTestId("needs-you-popover")).toBeVisible();
  await settle(page);
  record("needs-you popover: open until painted", `${Date.now() - opened} ms`);
  record("needs-you popover open, 12 streaming: hands off", await measure(page, cdp, WINDOW_MS));
  await page.evaluate(() => window.gramMock!.stopBusyThreads());
});

/** Self time by function over `during`, for attribution on a development build. */
const cpuProfile = async (cdp: CDPSession, during: () => Promise<void>) => {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await during();
  const { profile } = await cdp.send("Profiler.stop");
  const interval =
    (profile.endTime - profile.startTime) / Math.max(1, profile.samples?.length ?? 1);
  const hits = new Map<number, number>();
  for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
  const self = new Map<string, number>();
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url.split("/").slice(-2).join("/").split("?")[0];
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + ((hits.get(node.id) ?? 0) * interval) / 1000);
  }
  return [...self]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([key, ms]) => `${round(ms)} ms ${key}`)
    .join("<br>");
};

test("150 threads arrive at once", async ({ page }) => {
  const cdp = await start(page);
  const arrive = async () => {
    const ids = await page.evaluate(() =>
      window.gramMock!.seedBusyThreads({ streaming: 0, idle: 150 }),
    );
    await expect(threadRow(page, ids[0]!)).toBeVisible();
    await settle(page);
  };
  if (PROFILE) {
    record("150 threads arrive: CPU self time", await cpuProfile(cdp, arrive));
    return;
  }
  record("150 threads arrive", await measure(page, cdp, 0, arrive));
});

test.afterAll(() => {
  if (!PERF || results.length === 0) return;
  const lines = [
    "| Metric | Value |",
    "| --- | --- |",
    ...results.map(([metric, value]) => `| ${metric} | ${value.replaceAll("\n", "<br>")} |`),
  ];
  writeFileSync(OUT_FILE, `${lines.join("\n")}\n`);
  console.log(`results written to ${OUT_FILE}`);
});
