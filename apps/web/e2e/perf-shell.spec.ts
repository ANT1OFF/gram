import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

// The shell's always-on cost while many threads work: 20 streaming
// threads and 27 quiet ones in worktrees with pull requests, on the mock API. Opt in with
// GRAM_PERF_SHELL=1; `GRAM_PERF_OUT` names the results file and `GRAM_PERF_PROFILE=1` adds a CPU profile
// of the idle scenario and renders by component while idle, switching and in the budget test, for
// attribution. Run it on the production bundle at least once (`GRAM_E2E_SERVER=preview`):
// the dev build's React overstates render cost.
const PERF = process.env["GRAM_PERF_SHELL"] === "1";
const PROFILE = process.env["GRAM_PERF_PROFILE"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-shell-web.md");
const STREAMING = 20;
const QUIET = 27;
const WINDOW_MS = 10_000;

test.skip(!PERF, "set GRAM_PERF_SHELL=1 to measure the shell under load");
test.setTimeout(600_000);

const results: Array<[string, string]> = [];
const record = (metric: string, value: string) => {
  results.push([metric, value]);
  console.log(`${metric}: ${value}`);
};
const round = (n: number, digits = 1) => Number(n.toFixed(digits));

interface ShellPerf {
  commits: number;
  /** Renders and self time by component, from a development build's fiber timings. */
  renders: Record<string, { count: number; ms: number }>;
  longTasks: number[];
  events: number[];
}
type PerfWindow = Window & { gramShellPerf: ShellPerf };

/**
 * Counts React commits through the DevTools hook, which a production build calls too, and collects
 * long tasks and slow key events. Installed before the app loads, since React looks for the hook once.
 */
const instrument = (page: Page) =>
  page.addInitScript((attribute) => {
    const perf: ShellPerf = { commits: 0, renders: {}, longTasks: [], events: [] };
    (window as unknown as PerfWindow).gramShellPerf = perf;
    const HOOK = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
    const globals = window as unknown as Record<string, object | undefined>;
    const existing = globals[HOOK];
    let renderers = 0;
    globals[HOOK] = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => ++renderers,
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      checkDCE: () => {},
      ...existing,
      onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
        perf.commits++;
        if (attribute) walk(root.current);
      },
    };
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
    /** Adds up each component that rendered in this commit; a subtree that bailed out is skipped. */
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
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "keydown" || entry.name === "keypress" || entry.name === "input") {
          perf.events.push(entry.duration);
        }
      }
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
  }, PROFILE);

/** Takes and clears what `instrument` collected. */
const take = (page: Page) =>
  page.evaluate(() => {
    const perf = (window as unknown as PerfWindow).gramShellPerf;
    const out = {
      commits: perf.commits,
      renders: perf.renders,
      longTasks: [...perf.longTasks],
      events: [...perf.events],
    };
    perf.commits = 0;
    perf.renders = {};
    perf.longTasks.length = 0;
    perf.events.length = 0;
    return out;
  });

const MAIN_THREAD = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];

const mainThread = async (cdp: CDPSession) => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    MAIN_THREAD.map((name) => [name, metrics.find((m) => m.name === name)?.value ?? 0]),
  );
};

const heapMb = async (cdp: CDPSession) => {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { heap: value("JSHeapUsedSize") / (1024 * 1024), nodes: value("Nodes") };
};

const longest = (durations: readonly number[]) =>
  `${durations.length} over 50 ms, longest ${round(Math.max(0, ...durations))} ms`;

/** What the main thread did over `ms` with nobody touching the page, or while `during` runs. */
const measure = async (
  page: Page,
  cdp: CDPSession,
  ms: number,
  during?: () => Promise<void>,
): Promise<string> => {
  await take(page);
  const before = await mainThread(cdp);
  const started = Date.now();
  await (during?.() ?? page.waitForTimeout(ms));
  const seconds = (Date.now() - started) / 1000;
  const after = await mainThread(cdp);
  const { commits, longTasks } = await take(page);
  const busy = (name: string) => round(((after[name]! - before[name]!) / seconds) * 100);
  return (
    `main thread ${busy("TaskDuration")}% busy (script ${busy("ScriptDuration")}%, ` +
    `style ${busy("RecalcStyleDuration")}%, layout ${busy("LayoutDuration")}%), ` +
    `${round(commits / seconds)} React commits/s; long tasks: ${longest(longTasks)}`
  );
};

/** Self time by function over a CPU profile, for finding what the idle shell spends its time on. */
const profile = async (cdp: CDPSession, page: Page, ms: number) => {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await page.waitForTimeout(ms);
  const { profile: taken } = await cdp.send("Profiler.stop");
  const interval = (taken.endTime - taken.startTime) / Math.max(1, taken.samples?.length ?? 1);
  const hits = new Map<number, number>();
  for (const id of taken.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
  const self = new Map<string, number>();
  for (const node of taken.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url.split("/").slice(-2).join("/").split("?")[0];
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + ((hits.get(node.id) ?? 0) * interval) / 1000);
  }
  return [...self]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([key, value]) => `${round(value)} ms ${key}`)
    .join("\n");
};

/** Top components by self render time since the last `take`; development builds only. */
const topRenders = async (page: Page) => {
  const { renders } = await take(page);
  return Object.entries(renders)
    .toSorted((a, b) => b[1].ms - a[1].ms)
    .slice(0, 30)
    .map(([name, { count, ms }]) => `${round(ms)} ms in ${count} renders: ${name}`)
    .join("\n");
};

const seed = (page: Page) =>
  page.evaluate(
    ([streaming, idle]) => window.gramMock!.seedBusyThreads({ streaming: streaming!, idle: idle! }),
    [STREAMING, QUIET],
  );

/** Opens `threadId` from the sidebar and returns the time until its transcript has painted. */
const openThread = async (page: Page, threadId: string) => {
  const started = Date.now();
  await threadRow(page, threadId).click();
  await expect(page.getByTestId("pane").first()).toHaveAttribute("data-thread-id", threadId);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return Date.now() - started;
};

const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

test("20 working threads, a quiet one open: hands off, switching, a minute's growth", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await instrument(page);

  const navigated = Date.now();
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  record("cold load to sidebar rows", `${Date.now() - navigated} ms`);
  record("nothing working (baseline)", await measure(page, cdp, 5_000));

  const ids = await seed(page);
  const quiet = ids.slice(STREAMING);
  await expect(threadRow(page, ids[0]!)).toBeVisible();
  await page.waitForTimeout(2_000);

  record(`${STREAMING} working, quiet thread open, hands off`, await measure(page, cdp, WINDOW_MS));
  if (PROFILE) {
    await take(page);
    record("idle profile, self time", `\n${await profile(cdp, page, WINDOW_MS)}`);
    record(
      "idle profile, renders by component (development builds only)",
      `\n${await topRenders(page)}`,
    );
  }

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  record(
    `${STREAMING} working, quiet thread open, hands off, 4× throttle`,
    await measure(page, cdp, WINDOW_MS),
  );

  if (PROFILE) {
    await take(page);
    for (const id of quiet.slice(10, 15)) await openThread(page, id);
    record(
      "switching profile, renders by component (development builds only)",
      `\n${await topRenders(page)}`,
    );
  }
  const opens: number[] = [];
  record(
    "switching between 10 quiet threads, 4× throttle",
    await measure(page, cdp, 0, async () => {
      for (const id of quiet.slice(0, 10)) opens.push(await openThread(page, id));
    }),
  );
  record(
    "switch to a quiet thread, 4× throttle",
    `median ${median(opens)} ms, longest ${Math.max(...opens)} ms`,
  );

  // A leak would show as growth over a minute of steady work. The mock's own copy of what it
  // streams is bounded: `seedBusyThreads` starts a new message every 20 s.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await threadRow(page, "t-deps").click();
  await page.waitForTimeout(25_000);
  const start = await heapMb(cdp);
  await page.waitForTimeout(60_000);
  const end = await heapMb(cdp);
  record(
    "heap and DOM nodes over a minute, quiet thread open",
    `${round(start.heap)} MB, ${start.nodes} nodes → ${round(end.heap)} MB, ${end.nodes} nodes`,
  );
  await page.evaluate(() => window.gramMock!.stopBusyThreads());
});

// The budget test: a 2×2 grid of working threads, 20 working in all, 4× CPU throttle.
test("budget: 4 working panes of 20 working threads", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await instrument(page);
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const streaming = (await seed(page)).slice(0, STREAMING);
  await threadRow(page, streaming[0]!).click();
  await setLayout(page, "2×2");
  const panes = page.getByTestId("pane");
  await expect(panes).toHaveCount(4);
  for (const [index, id] of streaming.slice(1, 4).entries()) {
    await threadRow(page, id).dragTo(panes.nth(index + 1));
    await expect(panes.nth(index + 1)).toHaveAttribute("data-thread-id", id);
  }
  record("budget: 4 working panes", await measure(page, cdp, WINDOW_MS));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  record("budget: 4 working panes, 4× throttle", await measure(page, cdp, WINDOW_MS));
  if (PROFILE) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await take(page);
    await page.waitForTimeout(5_000);
    record(
      "budget profile, renders by component (development builds only)",
      `\n${await topRenders(page)}`,
    );
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }

  const composer = panes.nth(0).getByLabel("Message", { exact: true });
  await composer.click();
  await take(page);
  const sentence = "Measure how quickly the composer echoes keys under load.";
  await page.keyboard.type(sentence, { delay: 25 });
  const { events } = await take(page);
  const sorted = events.toSorted((a, b) => a - b);
  const at = (q: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  record(
    "budget: typing, 4× throttle",
    `${sorted.length} of ~${sentence.length * 3} key events over 16 ms, p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, longest ${round(sorted.at(-1) ?? 0)} ms`,
  );

  await page.evaluate(() => window.gramMock!.stopBusyThreads());
});

test("sidebar at scale: 150 threads", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await instrument(page);
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  // The overview lists them all under Solo threads, latest first; it has no grouping to switch, so
  // what is measured is the 150 rows arriving.
  await take(page);
  const started = Date.now();
  const ids = await page.evaluate(() =>
    window.gramMock!.seedBusyThreads({ streaming: 0, idle: 150 }),
  );
  await expect(threadRow(page, ids[0]!)).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const { longTasks } = await take(page);
  record(
    "150 threads: rows arrive",
    `${Date.now() - started} ms; long tasks: ${longest(longTasks)}`,
  );
  await page.waitForTimeout(2_000);
  const { nodes } = await heapMb(cdp);
  record("150 threads: DOM nodes", String(nodes));
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
