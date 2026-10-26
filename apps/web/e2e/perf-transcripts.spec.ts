import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { threadRow } from "./thread-row";

// Long threads in the renderer, on the mock API with generated transcripts. Opt in with
// GRAM_PERF_TRANSCRIPTS=1; `GRAM_PERF_OUT` names the results file.
const PERF = process.env["GRAM_PERF_TRANSCRIPTS"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-transcripts-web.md");
const MB = 1024 * 1024;

test.skip(!PERF, "set GRAM_PERF_TRANSCRIPTS=1 to measure long transcripts");
test.setTimeout(600_000);

const results: Array<[string, string]> = [];
const record = (metric: string, value: string) => {
  results.push([metric, value]);
  console.log(`${metric}: ${value}`);
};
const round = (n: number, digits = 1) => Number(n.toFixed(digits));

const seed = (page: Page, count: number, turns: number) =>
  page.evaluate(
    ([c, t]) => window.gramMock!.seedLongThreads({ count: c!, turns: t! }),
    [count, turns],
  );

const heapMb = async (cdp: CDPSession) => {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / MB;
};

/** Starts collecting long tasks and slow input events into `window.gramPerf`. */
const observe = (page: Page) =>
  page.evaluate(() => {
    const perf = { longTasks: [] as number[], events: [] as number[] };
    (window as unknown as { gramPerf: typeof perf }).gramPerf = perf;
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
  });

/** Takes and clears what `observe` collected. */
const take = (page: Page) =>
  page.evaluate(() => {
    const perf = (window as unknown as { gramPerf: { longTasks: number[]; events: number[] } })
      .gramPerf;
    const out = { longTasks: [...perf.longTasks], events: [...perf.events] };
    perf.longTasks.length = 0;
    perf.events.length = 0;
    return out;
  });

/** Types a sentence into the composer and reports the slow input events it caused. */
const typeSentence = async (page: Page) => {
  const composer = page.getByLabel("Message", { exact: true });
  await composer.click();
  await take(page);
  const sentence = "Measure how quickly the composer echoes keys on a long thread.";
  await page.keyboard.type(sentence, { delay: 25 });
  const { events, longTasks } = await take(page);
  const sorted = events.toSorted((a, b) => a - b);
  const at = (q: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  await composer.fill("");
  return `${sorted.length} of ~${sentence.length * 3} key events over 16 ms, p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, longest ${round(sorted.at(-1) ?? 0)} ms; long tasks: ${summary(longTasks)}`;
};

const summary = (durations: readonly number[]) => {
  const sorted = durations.toSorted((a, b) => a - b);
  const total = sorted.reduce((sum, d) => sum + d, 0);
  return `${sorted.length} over 50 ms, longest ${round(sorted.at(-1) ?? 0)} ms, ${round(total)} ms total`;
};

/** Opens `threadId` from the sidebar and returns the time until its transcript has painted. */
const openThread = async (page: Page, threadId: string) => {
  await page.evaluate(() => {
    (window as unknown as { gramOpenAt: number }).gramOpenAt = performance.now();
  });
  await threadRow(page, threadId).click();
  await expect(page.getByTestId("transcript").getByTestId("message-assistant").first()).toBeVisible(
    {
      timeout: 60_000,
    },
  );
  return page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve(performance.now() - (window as unknown as { gramOpenAt: number }).gramOpenAt),
          ),
        ),
      ),
  );
};

test("one thread with 1,000 turns: open, scroll, type, stream", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto("/");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await observe(page);
  await threadRow(page, "t-deps").click();
  await expect(page.getByTestId("transcript").locator("[data-message-id]").first()).toBeVisible();
  record("2-message thread: typing", await typeSentence(page));
  const baseline = await heapMb(cdp);
  const [threadId] = await seed(page, 1, 1_000);
  await expect(threadRow(page, threadId!)).toBeVisible();
  await take(page);

  record(
    "1,000 turns: open /t/<id> until painted",
    `${round(await openThread(page, threadId!))} ms`,
  );
  record("1,000 turns: long tasks while opening", summary((await take(page)).longTasks));
  record(
    "1,000 turns: renderer JS heap (before seeding → open)",
    `${round(baseline)} → ${round(await heapMb(cdp))} MB`,
  );

  const transcript = page.getByTestId("transcript");
  await transcript.hover();
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, -1_200);
    await page.waitForTimeout(16);
  }
  record("1,000 turns: long tasks scrolling up 96,000 px", summary((await take(page)).longTasks));
  await transcript.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(500);
  await take(page);

  record("1,000 turns: typing", await typeSentence(page));

  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(Array.from({ length: 300 }, (_, i) => `word${i}`).join(" "));
  await composer.press("ControlOrMeta+Enter");
  await expect(transcript.locator('[data-streaming="true"]')).toBeVisible({ timeout: 10_000 });
  await expect(transcript.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 60_000 });
  record(
    "1,000 turns: long tasks while a 300-word reply streams",
    summary((await take(page)).longTasks),
  );
  record("1,000 turns: renderer JS heap after streaming", `${round(await heapMb(cdp))} MB`);
});

test("a thread in the middle of a long turn: switch to it", async ({ page }) => {
  await page.goto("/");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await threadRow(page, "t-deps").click();
  await expect(page.getByTestId("transcript").locator("[data-message-id]").first()).toBeVisible();
  const threadId = await page.evaluate(() => window.gramMock!.seedInFlightTurn({ steps: 200 }));
  await expect(threadRow(page, threadId)).toBeVisible();
  // Let the mock's own fold of the seeded chunks finish before measuring.
  await page.waitForTimeout(3_000);
  await observe(page);

  // The feed is new to the window, so opening replays every chunk of the turn so far.
  record(
    "turn of 200 steps in flight: open until painted",
    `${round(await openThread(page, threadId))} ms`,
  );
  await page.waitForTimeout(1_000);
  record(
    "turn of 200 steps in flight: long tasks while opening",
    summary((await take(page)).longTasks),
  );
});

test("20 threads with 300 turns each: open each, memory", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto("/");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const baseline = await heapMb(cdp);
  const ids = await seed(page, 20, 300);
  await expect(threadRow(page, ids[0]!)).toBeVisible();
  await observe(page);

  const times: number[] = [];
  for (const id of ids) times.push(await openThread(page, id));
  const sorted = times.toSorted((a, b) => a - b);
  record(
    "20 × 300 turns: open each thread until painted (median / max)",
    `${round(sorted[10]!)} ms / ${round(sorted.at(-1)!)} ms`,
  );
  record("20 × 300 turns: long tasks opening all 20", summary((await take(page)).longTasks));
  record(
    "20 × 300 turns: renderer JS heap (before seeding → after opening all 20)",
    `${round(baseline)} → ${round(await heapMb(cdp))} MB`,
  );

  writeFileSync(
    OUT_FILE,
    `| Metric | Value |\n|---|---|\n${results.map(([m, v]) => `| ${m} | ${v} |`).join("\n")}\n`,
  );
  console.log(`perf results written to ${OUT_FILE}`);
});
