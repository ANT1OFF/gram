import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import type { MockScale } from "../src/api/mock-seeds";

// The renderer at scale, on the mock API: ten workspaces, 300 threads, an orchestrator with forty
// workers, a 5,000-message transcript of heavy tool output and a 3,000-line diff (`seedScale`).
// Every scenario runs `GRAM_PERF_RUNS` times (5 by default) on a fresh page and reports
// min / median / max across the runs. Opt in with GRAM_PERF_SCALE=1; `GRAM_PERF_OUT` names the
// results file, `GRAM_PERF_ONLY` runs the scenarios whose title contains it. Timings belong to the
// production bundle (`GRAM_E2E_SERVER=preview`); on a development build `GRAM_PERF_PROFILE=1` adds
// renders by component per streamed event.
const PERF = process.env["GRAM_PERF_SCALE"] === "1";
const PROFILE = process.env["GRAM_PERF_PROFILE"] === "1";
const RUNS = Number(process.env["GRAM_PERF_RUNS"] ?? 5);
const ONLY = process.env["GRAM_PERF_ONLY"];
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-scale-web.md");
const MB = 1024 * 1024;

test.skip(!PERF, "set GRAM_PERF_SCALE=1 to measure the app at scale");
// A trace snapshots the DOM at every action, a wheel step included, which would be measured too.
test.use({ trace: "off" });
test.setTimeout(1_800_000);

const scenario = (title: string, body: Parameters<typeof test>[2]) =>
  ONLY === undefined || title.includes(ONLY) ? test(title, body) : test.skip(title, body);

/**
 * Each run's value, appended to `<GRAM_PERF_OUT>.jsonl` so a worker that restarts after a failure
 * keeps what ran before it; delete that file to start over. The table reports min / median / max.
 */
const RAW_FILE = `${OUT_FILE}.jsonl`;
const record = (metric: string, value: number, unit = "ms") => {
  appendFileSync(RAW_FILE, `${JSON.stringify({ metric, value, unit })}\n`);
  console.log(`${metric}: ${round(value)} ${unit}`);
};
const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const quantile = (values: readonly number[], q: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

interface ScalePerf {
  commits: number;
  renders: Record<string, { count: number; ms: number }>;
  /** [start, duration] of each long task. */
  longTasks: [number, number][];
  /** Gaps between animation frames. */
  frames: number[];
  /** From a keydown's timestamp to the frame after it was handled. */
  keys: number[];
}
type PerfWindow = Window & { gramScalePerf: ScalePerf };

/**
 * Before the app loads: the scale scenario's flag, React commits through the DevTools hook (which a
 * production build calls too; renders by component on a development build), long tasks, frame
 * gaps and key-to-frame latency.
 */
const instrument = (context: BrowserContext) =>
  context.addInitScript((attribute) => {
    sessionStorage.setItem("gram.mock.orchestration", "scale");
    const perf: ScalePerf = { commits: 0, renders: {}, longTasks: [], frames: [], keys: [] };
    (window as unknown as PerfWindow).gramScalePerf = perf;
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
      for (const entry of list.getEntries()) perf.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
    let last = 0;
    const frame = (at: number) => {
      if (last !== 0) perf.frames.push(at - last);
      last = at;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    addEventListener(
      "keydown",
      (event) => {
        const at = event.timeStamp;
        requestAnimationFrame((painted) => perf.keys.push(painted - at));
      },
      true,
    );
  }, PROFILE);

/** Takes and clears what `instrument` collected. */
const take = (page: Page) =>
  page.evaluate(() => {
    const perf = (window as unknown as PerfWindow).gramScalePerf;
    const out = {
      commits: perf.commits,
      renders: perf.renders,
      longTasks: [...perf.longTasks],
      frames: [...perf.frames],
      keys: [...perf.keys],
    };
    perf.commits = 0;
    perf.renders = {};
    perf.longTasks.length = 0;
    perf.frames.length = 0;
    perf.keys.length = 0;
    return out;
  });

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

const heap = async (cdp: CDPSession) => {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    mb: value("JSHeapUsedSize") / MB,
    nodes: value("Nodes"),
    listeners: value("JSEventListeners"),
  };
};

/** What the scale scenario made, once the page's mock is up. */
const scaleOf = async (page: Page): Promise<MockScale> => {
  await page.waitForFunction(() => window.gramMock !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(async () => (await window.gramMock!.startedScale())!);
};

interface Run {
  page: Page;
  cdp: CDPSession;
  made: MockScale;
}

/** A fresh page on the scale scenario, loaded and seeded, with `instrument`'s counters cleared. */
const open = async (browser: Browser): Promise<Run & { close: () => Promise<void> }> => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await instrument(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto("/");
  const made = await scaleOf(page);
  await expect(page.getByTestId("overview-sidebar")).toContainText("scale-1", { timeout: 60_000 });
  await page.waitForTimeout(1_500);
  await take(page);
  return { page, cdp, made, close: () => context.close() };
};

/** Each of `RUNS` runs on a fresh page. */
const repeat = async (browser: Browser, body: (run: Run, index: number) => Promise<void>) => {
  for (let i = 0; i < RUNS; i++) {
    const run = await open(browser);
    try {
      await body(run, i);
    } finally {
      await run.close();
    }
  }
};

/** From now until `target` is visible and two frames have drawn after it. */
const timeTo = async (page: Page, act: () => Promise<void>, painted: () => Promise<void>) => {
  const started = await page.evaluate(() => performance.now());
  await act();
  await painted();
  await settle(page);
  return (await page.evaluate(() => performance.now())) - started;
};

const transcriptPainted = (page: Page) => () =>
  expect(page.getByTestId("transcript").locator("[data-message-id]").first()).toBeVisible({
    timeout: 60_000,
  });

/** The components that spent most self time, on a development build. */
const topRenders = (renders: ScalePerf["renders"], count = 25) =>
  Object.entries(renders)
    .toSorted((a, b) => b[1].ms - a[1].ms)
    .slice(0, count)
    .map(([name, { count: times, ms }]) => `${round(ms)} ms/${times}× ${name}`)
    .join(", ");

/** Long frames and long tasks over `scroll`. */
const jank = async (page: Page, label: string, scroll: () => Promise<void>) => {
  await take(page);
  await scroll();
  await page.waitForTimeout(300);
  const { frames, longTasks, renders } = await take(page);
  if (PROFILE) console.log(`${label} renders: ${topRenders(renders)}`);
  record(`${label}: frames over 50 ms`, frames.filter((gap) => gap > 50).length, "frames");
  record(`${label}: frame p95`, quantile(frames, 0.95));
  record(`${label}: longest frame`, Math.max(0, ...frames));
  record(
    `${label}: long-task total`,
    longTasks.reduce((sum, [, d]) => sum + d, 0),
  );
};

const wheel = async (page: Page, steps: number, dy: number) => {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(16);
  }
};

scenario("time to interactive", async ({ browser }) => {
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await instrument(context);
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("overview-sidebar")).toContainText("scale-1", {
      timeout: 60_000,
    });
    await settle(page);
    // Interactive: the sidebar shows the scale scenario, then a second passes without a long task.
    const shown = await page.evaluate(() => performance.now());
    let quietFrom = shown;
    for (;;) {
      await page.waitForTimeout(1_000);
      const ends = (await take(page)).longTasks.map(([start, d]) => start + d);
      const last = Math.max(0, ...ends);
      if (last <= quietFrom) break;
      quietFrom = last;
    }
    const interactive = Math.max(shown, quietFrom);
    const marks = await page.evaluate((until) => {
      const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
      const scripts = performance
        .getEntriesByType("resource")
        .filter((entry) => /\.m?js(\?|$)/.test(entry.name)) as PerformanceResourceTiming[];
      // What had arrived by then: a script fetched before a moment is parsed and run before it too.
      const by = (at: number) => {
        const arrived = scripts.filter((entry) => entry.responseEnd <= at);
        return {
          files: arrived.length,
          kB: arrived.reduce((sum, entry) => sum + entry.decodedBodySize, 0) / 1000,
        };
      };
      return {
        fcp,
        seed: performance.getEntriesByName("gram-mock-seed")[0]?.duration ?? 0,
        beforePaint: by(fcp),
        beforeInteractive: by(until),
      };
    }, interactive);
    record("load: first contentful paint", marks.fcp);
    record("load: sidebar shows 300 threads", shown);
    record("load: interactive (no long task for 1 s)", interactive);
    record("load: of which the mock's own seeding", marks.seed);
    record("load: JS before first contentful paint: files", marks.beforePaint.files, "files");
    record("load: JS before first contentful paint: uncompressed", marks.beforePaint.kB, "kB");
    record("load: JS before interactive: files", marks.beforeInteractive.files, "files");
    record("load: JS before interactive: uncompressed", marks.beforeInteractive.kB, "kB");
    await context.close();
  }
});

scenario("thread switch", async ({ browser }) => {
  await repeat(browser, async ({ page, made }) => {
    const to = (id: string) =>
      timeTo(page, () => goInApp(page, `/t/${id}`), transcriptPainted(page));
    record("switch: to a 6-message worker", await to(made.workerIds[3]!));
    record("switch: to the 5,000-message thread, first time", await to(made.longThreadId));
    record("switch: to a 2-turn thread", await to(made.looseIds[5]!));
    record("switch: to the 5,000-message thread, again", await to(made.longThreadId));
    record("switch: to the 60-turn orchestrator", await to(made.orchestratorThreadId));
    const { longTasks, renders } = await take(page);
    if (PROFILE) console.log(`switch renders: ${topRenders(renders)}`);
    record(
      "switch: long-task total over the five",
      longTasks.reduce((sum, [, d]) => sum + d, 0),
    );
  });
});

scenario("typing while a turn streams", async ({ browser }) => {
  await repeat(browser, async ({ page, made }) => {
    await goInApp(page, `/t/${made.longThreadId}`);
    await transcriptPainted(page)();
    const composer = page.getByLabel("Message", { exact: true });
    await page.evaluate((id) => window.gramMock!.streamThread(id as never), made.longThreadId);
    await expect(page.getByTestId("transcript").locator('[data-streaming="true"]')).toBeVisible({
      timeout: 10_000,
    });
    await composer.click();
    await page.waitForTimeout(500);
    await take(page);
    await page.keyboard.type(
      "Measure how quickly the composer echoes keys while a reply streams.",
      {
        delay: 40,
      },
    );
    const { keys, longTasks } = await take(page);
    record("typing, 5,000 messages streaming: key to frame p50", quantile(keys, 0.5));
    record("typing, 5,000 messages streaming: key to frame p95", quantile(keys, 0.95));
    record("typing, 5,000 messages streaming: key to frame max", Math.max(0, ...keys));
    record("typing, 5,000 messages streaming: long tasks", longTasks.length, "tasks");
    await page.evaluate(() => window.gramMock!.stopBusyThreads());
  });
});

scenario("renders per streamed event", async ({ browser }) => {
  await repeat(browser, async ({ page, made }, index) => {
    await goInApp(page, `/t/${made.longThreadId}`);
    await transcriptPainted(page)();
    await page.waitForTimeout(1_000);
    await take(page);
    await page.evaluate((id) => window.gramMock!.streamThread(id as never), made.longThreadId);
    // 125 ticks: a text delta each, a status line every 25, usage every 50, git every 125.
    await page.waitForTimeout(5_000);
    await page.evaluate(() => window.gramMock!.stopBusyThreads());
    const { commits, renders } = await take(page);
    record("streaming: React commits per text delta", commits / 125, "commits");
    if (PROFILE && index === 0) {
      const top = Object.entries(renders)
        .toSorted((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([name, { count, ms }]) => `${round(count / 125, 2)}×/delta ${round(ms)} ms ${name}`)
        .join("; ");
      console.log(`renders per delta: ${top}`);
    }
  });
});

scenario("scroll: transcript", async ({ browser }) => {
  await repeat(browser, async ({ page, made }) => {
    await goInApp(page, `/t/${made.longThreadId}`);
    await transcriptPainted(page)();
    await page.waitForTimeout(1_000);
    await page.getByTestId("transcript").hover();
    await jank(page, "scroll 5,000-message transcript up 72,000 px", () => wheel(page, 60, -1_200));
  });
});

scenario("scroll: sidebar", async ({ browser }) => {
  await repeat(browser, async ({ page }) => {
    await page.getByTestId("overview-sidebar").hover();
    await jank(page, "scroll sidebar down and up", async () => {
      await wheel(page, 40, 600);
      await wheel(page, 40, -600);
    });
  });
});

scenario("scroll: Board", async ({ browser }) => {
  await repeat(browser, async ({ page, made }) => {
    const opened = await timeTo(
      page,
      async () => {
        await goInApp(page, `/t/${made.orchestratorThreadId}`);
        await page
          .getByTestId("view-switcher")
          .getByRole("radio", { name: /^Board\b/ })
          .click();
      },
      () => expect(page.getByTestId("rail-board")).toBeVisible({ timeout: 30_000 }),
    );
    record("Board, 40 workers: open until painted", opened);
    await page.waitForTimeout(1_000);
    await page.getByTestId("rail-board").hover();
    await jank(page, "scroll Board down and up", async () => {
      await wheel(page, 30, 600);
      await wheel(page, 30, -600);
    });
  });
});

scenario("scroll: diff", async ({ browser }) => {
  await repeat(browser, async ({ page, made }) => {
    await goInApp(page, `/t/${made.longThreadId}`);
    await transcriptPainted(page)();
    const panel = page.getByTestId("diff-panel");
    const opened = await timeTo(
      page,
      async () => {
        if ((await panel.count()) === 0) await page.keyboard.press("ControlOrMeta+Shift+KeyD");
      },
      () => expect(panel.getByTestId("diff-file").first()).toBeVisible({ timeout: 30_000 }),
    );
    record("diff, 3,000 lines over 20 files: open until painted", opened);
    await page.waitForTimeout(1_000);
    await panel.getByTestId("diff-file").first().hover();
    await jank(page, "scroll diff down", () => wheel(page, 60, 1_000));
  });
});

scenario("⌘J Workers list", async ({ browser }) => {
  await repeat(browser, async ({ page, made }) => {
    await goInApp(page, `/t/${made.orchestratorThreadId}`);
    await transcriptPainted(page)();
    const list = page.getByTestId("workers-list");
    const opened = await timeTo(
      page,
      () => page.keyboard.press("ControlOrMeta+KeyJ"),
      () => expect(list).toBeVisible({ timeout: 30_000 }),
    );
    record("⌘J, 40 workers: open until painted", opened);
    record("⌘J, 40 workers: rows drawn", await list.getByTestId("worker-row").count(), "rows");
    await page.waitForTimeout(500);
    await list.hover();
    await jank(page, "scroll ⌘J list", async () => {
      await wheel(page, 20, 400);
      await wheel(page, 20, -400);
    });
  });
});

scenario("an hour of streaming", async ({ browser }) => {
  await repeat(browser, async ({ page, cdp, made }) => {
    const watched = made.workerIds[2]!;
    await goInApp(page, `/t/${watched}`);
    await transcriptPainted(page)();
    await page.waitForTimeout(1_000);
    const start = await heap(cdp);
    // Thirty ticks every 40 ms: an hour of one thread's turn in two minutes, into the open thread
    // and five others the sidebar and Board show working.
    await page.evaluate(
      (ids) => {
        for (const id of ids) window.gramMock!.streamThread(id as never, 30);
      },
      [watched, ...made.workerIds.slice(10, 15)],
    );
    for (let minute = 15; minute <= 60; minute += 15) {
      await page.waitForTimeout(30_000);
      const at = await heap(cdp);
      record(`an hour of streaming: JS heap growth at ${minute} min`, at.mb - start.mb, "MB");
    }
    await page.evaluate(() => window.gramMock!.stopBusyThreads());
    const streamed = await heap(cdp);
    record("an hour of streaming: DOM node growth", streamed.nodes - start.nodes, "nodes");
    record(
      "an hour of streaming: event listener growth",
      streamed.listeners - start.listeners,
      "listeners",
    );
    // Away from the streamed thread, what it drew should go.
    await goInApp(page, `/t/${made.looseIds[0]!}`);
    await transcriptPainted(page)();
    await page.waitForTimeout(2_000);
    const away = await heap(cdp);
    record("an hour of streaming: JS heap growth after leaving", away.mb - start.mb, "MB");
    record(
      "an hour of streaming: DOM node growth after leaving",
      away.nodes - start.nodes,
      "nodes",
    );
  });
});

scenario("JS per route", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await instrument(context);
  const probe = await context.newPage();
  await probe.goto("/");
  const made = await scaleOf(probe);
  await context.close();
  const routes: [string, string][] = [
    ["/", "start"],
    [`/t/${made.longThreadId}`, "a thread"],
    ["/settings/general", "Settings · General"],
    ["/settings/appearance", "Settings · Appearance"],
    ["/usage", "Usage"],
    [`/w/${made.workspaceIds[0]!}/memory`, "a workspace's memory"],
  ];
  for (const [path, name] of routes) {
    // Fresh each time; thread ids are the same on each page, as the seed is deterministic in order.
    const fresh = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await instrument(fresh);
    const page = await fresh.newPage();
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);
    const { files, bytes } = await page.evaluate(() => {
      const scripts = performance
        .getEntriesByType("resource")
        .filter((entry) => /\.m?js(\?|$)/.test(entry.name)) as PerformanceResourceTiming[];
      return {
        files: scripts.length,
        bytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      };
    });
    record(`JS loaded at ${name}: files`, files, "files");
    record(`JS loaded at ${name}: uncompressed`, bytes / 1000, "kB");
    await fresh.close();
  }
});

test.afterAll(() => {
  if (!PERF || !existsSync(RAW_FILE)) return;
  const results = new Map<string, { unit: string; values: number[] }>();
  for (const line of readFileSync(RAW_FILE, "utf8").split("\n")) {
    if (line === "") continue;
    const { metric, value, unit } = JSON.parse(line) as {
      metric: string;
      value: number;
      unit: string;
    };
    const entry = results.get(metric) ?? { unit, values: [] };
    entry.values.push(value);
    results.set(metric, entry);
  }
  const lines = [
    `Runs: ${RUNS}. Values are min / median / max.`,
    "",
    "| Metric | min / median / max |",
    "| --- | --- |",
    ...[...results].map(([metric, { unit, values }]) => {
      const sorted = values.toSorted((a, b) => a - b);
      const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
      return `| ${metric} | ${round(sorted[0]!)} / ${round(median)} / ${round(sorted.at(-1)!)} ${unit} |`;
    }),
  ];
  writeFileSync(OUT_FILE, `${lines.join("\n")}\n`);
  console.log(`results written to ${OUT_FILE}`);
});
