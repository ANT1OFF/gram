import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

import { seedTheme } from "./seed-theme";
import { threadRow } from "./thread-row";

const errors = new WeakMap<Page, string[]>();
const shots = process.env["GRAM_SCROLL_SHOTS"];
const phase = process.env["GRAM_SCROLL_PHASE"] ?? "after";
// Playwright hides native scrollbars by default; this suite exercises their actual hit target.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.beforeEach(async ({ page }) => {
  const observed: string[] = [];
  errors.set(page, observed);
  page.on("pageerror", (error) => observed.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") observed.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedTheme(page, { palette: "neutral-dark", mode: "dark", motion: "off" });
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [],
        claudeSignIn: "notSignedIn",
        codexSignIn: "notSignedIn",
        ghSignedIn: false,
        agentsInUse: [],
      }),
    );
    sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
  });
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

async function open(page: Page) {
  await page.goto("/");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  const id = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const [created] = mock.seedLongThreads({ count: 1, turns: 0 });
    await mock.rename(created!, "Synthetic streaming scroll");
    await mock.setModel(created!, { agent: "codex", model: "gpt-5.4" });
    for (let i = 0; i < 20; i++) {
      mock.simulateMessage(created!, {
        id: `scroll-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `Invented earlier message ${i}.\n\n`.repeat(4) }],
      });
    }
    mock.simulateStatus(created!, "running");
    return created!;
  });
  await threadRow(page, id).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="scroll-19"]'),
  ).toBeInViewport();
  await page.evaluate(
    (targetId) =>
      window.gramMock!.simulateChunks(targetId as never, "scroll-live" as never, [
        { type: "start", messageId: "scroll-live" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "Invented streamed line.\n\n".repeat(40) },
      ]),
    id,
  );
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="scroll-live"]'),
  ).toBeInViewport();
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  return id;
}

async function geometry(page: Page) {
  return page.getByTestId("transcript").evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
    rowTop:
      el.querySelector('[data-message-id="scroll-live"]')!.getBoundingClientRect().top -
      el.getBoundingClientRect().top,
  }));
}

async function grow(page: Page, id: string) {
  for (let i = 0; i < 8; i++) {
    const height = (await geometry(page)).height;
    await page.evaluate(
      (targetId) =>
        window.gramMock!.simulateChunks(targetId as never, "scroll-live" as never, [
          { type: "text-delta", id: "text", delta: "More invented streaming text.\n\n" },
        ]),
      id,
    );
    await expect.poll(() => geometry(page).then((g) => g.height)).toBeGreaterThan(height);
  }
}

/**
 * Gives the transcript a 16 px native scrollbar, Chromium's persistent hit target rather than an OS
 * overlay, and the point just inside the bottom of its thumb once the layout has taken it: the
 * narrower content rewraps and the view re-pins to the end, which moves the thumb meanwhile.
 */
async function nativeScrollbar(page: Page) {
  await page.addStyleTag({
    content: '[data-testid="transcript"]::-webkit-scrollbar { width: 16px; }',
  });
  const scroller = page.getByTestId("transcript");
  await expect
    .poll(() => scroller.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth))
    .toBe(16);
  await scroller.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        let previous = "";
        let stable = 0;
        const frame = () => {
          const now = `${el.scrollHeight}:${el.scrollTop}`;
          stable = previous === now ? stable + 1 : 0;
          previous = now;
          if (stable >= 4) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  const box = (await scroller.boundingBox())!;
  const thumb = await scroller.evaluate((el) => el.clientHeight ** 2 / el.scrollHeight);
  return { x: box.x + box.width - 5, y: box.y + box.height - thumb / 2 - 2 };
}

async function settled(page: Page) {
  await page.getByTestId("transcript").evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        let previous = el.scrollTop;
        let stable = 0;
        const frame = () => {
          stable = previous === el.scrollTop ? stable + 1 : 0;
          previous = el.scrollTop;
          if (stable >= 4) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

async function receipt(name: string, reading: Awaited<ReturnType<typeof geometry>>, page: Page) {
  const after = await geometry(page);
  const body = JSON.stringify({ reading, after });
  await test.info().attach(name, { body, contentType: "application/json" });
  if (shots) {
    mkdirSync(shots, { recursive: true });
    writeFileSync(`${shots}/${phase}-${name}.json`, body);
  }
  expect(Math.abs(after.top - reading.top)).toBeLessThan(2);
  expect(Math.abs(after.rowTop - reading.rowTop)).toBeLessThan(2);
}

declare global {
  interface Window {
    scrollReviewEvents?: Array<{
      kind: string;
      trusted: boolean;
      deltaY?: number | undefined;
      key?: string | undefined;
      top: number;
      bottom: number;
      target: string;
    }>;
  }
}

async function observeInput(page: Page) {
  await page.getByTestId("transcript").evaluate((el) => {
    window.scrollReviewEvents = [];
    for (const kind of ["wheel", "scroll", "keydown", "pointerdown", "pointerup", "touchmove"]) {
      el.addEventListener(
        kind,
        (event) =>
          window.scrollReviewEvents!.push({
            kind,
            trusted: event.isTrusted,
            deltaY: event instanceof WheelEvent ? event.deltaY : undefined,
            key: event instanceof KeyboardEvent ? event.key : undefined,
            top: el.scrollTop,
            bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
            target: event.target instanceof Element ? event.target.tagName : "unknown",
          }),
        { capture: true },
      );
    }
  });
}

async function partialReturn(page: Page) {
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -48);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(40);
  await page.mouse.wheel(0, 16);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBe(32);
  await settled(page);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
}

async function reviewReceipt(
  page: Page,
  id: string,
  name: string,
  reading: Awaited<ReturnType<typeof geometry>>,
  before?: unknown,
) {
  const pausedBefore = await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .count();
  await grow(page, id);
  const after = await geometry(page);
  const events = await page.evaluate(() => window.scrollReviewEvents);
  const body = JSON.stringify({ before, reading, pausedBefore, after, events });
  await test.info().attach(name, { body, contentType: "application/json" });
  if (shots) {
    mkdirSync(shots, { recursive: true });
    writeFileSync(`${shots}/${phase}-${name}.json`, body);
    await page.screenshot({ path: `${shots}/${phase}-${name}.png` });
  }
  expect(events?.filter((event) => event.kind !== "scroll").every((event) => event.trusted)).toBe(
    true,
  );
  expect(Math.abs(after.top - reading.top)).toBeLessThan(2);
  expect(Math.abs(after.rowTop - reading.rowTop)).toBeLessThan(2);
  expect(pausedBefore).toBe(1);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
}

async function inputReceipt(page: Page, name: string, before?: unknown) {
  const events = await page.evaluate(() => window.scrollReviewEvents);
  const body = JSON.stringify({ before, after: await geometry(page), events });
  await test.info().attach(name, { body, contentType: "application/json" });
  if (shots) {
    mkdirSync(shots, { recursive: true });
    writeFileSync(`${shots}/${phase}-${name}.json`, body);
  }
}

async function nestedOutput(page: Page, id: string) {
  await page.evaluate(
    (targetId) =>
      window.gramMock!.simulateChunks(targetId as never, "scroll-live" as never, [
        {
          type: "tool-input-available",
          toolCallId: "nested-tool",
          toolName: "Bash",
          input: { command: "echo invented" },
        },
        {
          type: "tool-output-available",
          toolCallId: "nested-tool",
          output: {
            stdout: "Nested invented output line.\n".repeat(80),
            stderr: "",
            interrupted: false,
          },
        },
      ]),
    id,
  );
  const tool = page.getByTestId("transcript").locator('[data-tool-call-id="nested-tool"]');
  await tool.locator("button").first().click();
  await expect(tool.locator("button").first()).toHaveAttribute("data-panel-open");
  await settled(page);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await settled(page);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  const pre = tool.locator("pre").filter({ hasText: "Nested invented output line." }).last();
  await expect(pre).toBeInViewport();
  const inner = await pre.evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    client: el.clientHeight,
  }));
  expect(inner.height).toBeGreaterThan(inner.client + 500);
  return pre;
}

for (const layout of ["height", "compaction", "unchanged"] as const) {
  test(`review F1: partial downward input then ${layout} preserves manual pause`, async ({
    page,
  }) => {
    const id = await open(page);
    if (layout === "compaction") {
      await page.evaluate(
        (targetId) =>
          window.gramMock!.simulateStatus(targetId as never, "running", undefined, {
            startedAt: 1000,
            trigger: "auto",
          }),
        id,
      );
      await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
      await settled(page);
    }
    await observeInput(page);
    await partialReturn(page);
    const before = await geometry(page);
    if (layout === "height") await page.setViewportSize({ width: 1440, height: 960 });
    else if (layout === "compaction") {
      await page.evaluate(
        (targetId) => window.gramMock!.simulateStatus(targetId as never, "running"),
        id,
      );
      await expect.poll(() => geometry(page).then((g) => g.height)).toBeLessThan(before.height);
    }
    await settled(page);
    const reading = await geometry(page);
    if (layout !== "unchanged") {
      expect(reading.top).toBeLessThan(before.top);
      expect(reading.bottom).toBe(0);
    }
    await reviewReceipt(page, id, `review-${layout}-clamp`, reading, before);
  });
}

test("review F1 control: backward-only resize stays paused", async ({ page }) => {
  const id = await open(page);
  await observeInput(page);
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBe(32);
  await page.setViewportSize({ width: 1440, height: 960 });
  await settled(page);
  await reviewReceipt(page, id, "review-backward-clamp", await geometry(page));
});

for (const down of [false, true]) {
  test(`review F2: ${down ? "downward inner output" : "upward-only inner control"} retains outer pause`, async ({
    page,
  }) => {
    const id = await open(page);
    const pre = await nestedOutput(page, id);
    await observeInput(page);
    await pre.hover();
    await page.mouse.wheel(0, -0.5);
    await settled(page);
    await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
    const reading = await geometry(page);
    const innerBefore = await pre.evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
      client: el.clientHeight,
    }));
    if (down) {
      await page.mouse.wheel(0, 32);
      await expect.poll(() => pre.evaluate((el) => el.scrollTop)).toBe(32);
      await settled(page);
    }
    const afterInput = await geometry(page);
    expect(afterInput.top).toBe(reading.top);
    expect(afterInput.bottom).toBe(0);
    const innerAfter = await pre.evaluate((el) => el.scrollTop);
    await reviewReceipt(page, id, down ? "review-nested-down" : "review-nested-up", reading, {
      innerBefore,
      innerAfter,
      afterInput,
    });
  });
}

test("outer native End resumes after manual reading", async ({ page }) => {
  const id = await open(page);
  await observeInput(page);
  await partialReturn(page);
  await page
    .getByTestId("transcript")
    .locator('[data-message-id="scroll-live"]')
    .evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press("End");
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  const events = await page.evaluate(() => window.scrollReviewEvents);
  expect(
    events?.some((event) => event.kind === "keydown" && event.key === "End" && event.trusted),
  ).toBe(true);
  await inputReceipt(page, "outer-native-end");
});

test("fresh downward wheel at the outer clamped end explicitly resumes follow", async ({
  page,
}) => {
  const id = await open(page);
  await observeInput(page);
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -0.5);
  await settled(page);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
  const before = await geometry(page);
  await page.mouse.wheel(0, 32);
  await settled(page);
  expect((await geometry(page)).top).toBe(before.top);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await inputReceipt(page, "outer-clamped-wheel", before);
});

test("wheel at an inner output boundary preserves native chaining to the outer end", async ({
  page,
}) => {
  const id = await open(page);
  const pre = await nestedOutput(page, id);
  await observeInput(page);
  await pre.hover();
  await page.mouse.wheel(0, -0.5);
  await settled(page);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
  // Stage only the actual inner boundary; this bare inner scroll cannot resume the outer view.
  await pre.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await settled(page);
  const innerEnd = await pre.evaluate((el) => el.scrollTop);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
  await page.mouse.wheel(0, 32);
  await settled(page);
  expect(await pre.evaluate((el) => el.scrollTop)).toBe(innerEnd);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await inputReceipt(page, "inner-boundary-chain", { innerEnd });
});

/** Native input only; receipts survive failed delivery/ownership assertions. */
async function nativeTouchScroll(page: Page, owner: Locator, distance: number, name: string) {
  const before = await geometry(page);
  const target = await owner.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      hit: hit?.tagName,
      ownsHit: hit !== null && element.contains(hit),
      maxTouchPoints: navigator.maxTouchPoints,
      touchEvents: "ontouchstart" in window,
    };
  });
  const session = await page.context().newCDPSession(page);
  await owner.evaluate((element) => {
    const state = { events: [] as Array<Record<string, unknown>>, stop: () => {} };
    const capture = (event: Event) => {
      const touches =
        event instanceof TouchEvent
          ? Array.from(event.touches).map((p) => ({ x: p.clientX, y: p.clientY }))
          : undefined;
      state.events.push({
        kind: event.type,
        trusted: event.isTrusted,
        target: event.target instanceof Element ? event.target.tagName : null,
        ownerContainsTarget: event.target instanceof Node && element.contains(event.target),
        pointerType: event instanceof PointerEvent ? event.pointerType : undefined,
        x: event instanceof PointerEvent ? event.clientX : undefined,
        y: event instanceof PointerEvent ? event.clientY : undefined,
        touches,
        ownerTop: element.scrollTop,
      });
    };
    const kinds = [
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
      "pointerdown",
      "pointermove",
      "pointerup",
      "scroll",
    ];
    for (const kind of kinds)
      document.addEventListener(kind, capture, { capture: true, passive: true });
    state.stop = () => {
      for (const kind of kinds) document.removeEventListener(kind, capture, true);
    };
    (window as unknown as { nativeTouchDiagnostic: typeof state }).nativeTouchDiagnostic = state;
  });
  try {
    expect(target.ownsHit).toBe(true);
    expect(target.maxTouchPoints).toBeGreaterThan(0);
    expect(target.touchEvents).toBe(true);
    // The original one-shot synthesized gesture produced no touchmove receipt. Send a
    // bounded native trajectory, allowing a compositor frame per move, without JS events.
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: target.x, y: target.y }],
    });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: target.x, y: target.y - (distance * step) / 8 }],
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const events = await page.evaluate(
      () =>
        (
          window as unknown as {
            nativeTouchDiagnostic: {
              events: Array<{ kind: string; trusted: boolean; ownerContainsTarget: boolean }>;
            };
          }
        ).nativeTouchDiagnostic.events,
    );
    for (const kind of ["touchstart", "touchmove", "touchend"]) {
      expect(
        events.some((event) => event.kind === kind && event.trusted && event.ownerContainsTarget),
      ).toBe(true);
    }
  } finally {
    const events = await page.evaluate(() => {
      const state = (
        window as unknown as { nativeTouchDiagnostic: { events: unknown[]; stop: () => void } }
      ).nativeTouchDiagnostic;
      state.stop();
      return state.events;
    });
    await test.info().attach(name, {
      body: JSON.stringify({ target, distance, before, after: await geometry(page), events }),
      contentType: "application/json",
    });
    await session.detach();
  }
}

for (const input of ["keyboard", "touch", "scrollbar"] as const) {
  const register = () => {
    test(`inner output ${input} scrolls its owner while outer reading stays paused`, async ({
      page,
    }) => {
      const id = await open(page);
      const pre = await nestedOutput(page, id);
      await observeInput(page);
      await pre.hover();
      await page.mouse.wheel(0, -0.5);
      await settled(page);
      const reading = await geometry(page);
      if (input === "keyboard") {
        await pre.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
        await expect(pre).toBeFocused();
        await page.keyboard.press("End");
      } else if (input === "touch") {
        await nativeTouchScroll(page, pre, 64, "inner-native-touch");
      } else {
        await page.addStyleTag({
          content: '[data-tool-call-id="nested-tool"] pre::-webkit-scrollbar { width: 16px; }',
        });
        const box = (await pre.boundingBox())!;
        const thumb = await pre.evaluate((el) => el.clientHeight ** 2 / el.scrollHeight);
        await page.mouse.move(box.x + box.width - 5, box.y + thumb / 2 + 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 5, box.y + thumb / 2 + 6, { steps: 4 });
        await page.mouse.up();
      }
      await expect.poll(() => pre.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await settled(page);
      expect((await geometry(page)).top).toBe(reading.top);
      const kind =
        input === "keyboard" ? "keydown" : input === "touch" ? "touchmove" : "pointerdown";
      const events = await page.evaluate(() => window.scrollReviewEvents);
      expect(
        events?.some((event) => event.kind === kind && event.target === "PRE" && event.trusted),
      ).toBe(true);
      await reviewReceipt(page, id, `review-nested-${input}`, reading, {
        innerAfter: await pre.evaluate((el) => el.scrollTop),
      });
    });
  };
  if (input === "touch") {
    test.describe("touch-capable context", () => {
      test.use({ hasTouch: true });
      register();
    });
  } else register();
}

test("native outer scrollbar return to the bottom resumes following", async ({ page }) => {
  const id = await open(page);
  const { x, y } = await nativeScrollbar(page);
  await observeInput(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 4, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(20);
  await settled(page);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
  await page.mouse.move(x, y - 4);
  await page.mouse.down();
  await page.mouse.move(x, y + 4, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await inputReceipt(page, "outer-scrollbar-return");
});

test.describe("touch-capable outer context", () => {
  test.use({ hasTouch: true });
  test("outer native touch return resumes follow after reading above the end", async ({ page }) => {
    const id = await open(page);
    await observeInput(page);
    const transcript = page.getByTestId("transcript");
    await transcript.hover();
    await page.mouse.wheel(0, -32);
    await expect.poll(() => geometry(page).then((g) => g.bottom)).toBe(32);
    const before = await geometry(page);
    await nativeTouchScroll(page, transcript, 160, "outer-native-touch");
    await inputReceipt(page, "outer-touch-delivered", before);
    await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
    await inputReceipt(page, "outer-touch-at-end", before);
    await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
    await grow(page, id);
    await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
    const events = await page.evaluate(() => window.scrollReviewEvents);
    expect(events?.some((event) => event.kind === "touchmove" && event.trusted)).toBe(true);
    await inputReceipt(page, "outer-touch-return", before);
  });
});

test("upward wheel inside the former 64px follow threshold preserves the reading position", async ({
  page,
}) => {
  const id = await open(page);
  const scroller = page.getByTestId("transcript");
  await scroller.hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  const reading = await geometry(page);
  expect(reading.bottom).toBeLessThan(64);
  await grow(page, id);
  if (shots) await page.screenshot({ path: `${shots}/${phase}-wheel.png` });
  await receipt("wheel-reading-geometry", reading, page);
});

test("small trackpad-style wheel input pauses bottom remeasurement before any scroll event", async ({
  page,
}) => {
  const id = await open(page);
  const before = await geometry(page);
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -0.5);
  await settled(page);
  const reading = await geometry(page);
  expect(before.top - reading.top).toBeLessThan(2);
  await grow(page, id);
  await receipt("subpixel-reading-geometry", reading, page);
});

test("ArrowUp reading stays paused and Jump to latest resumes following", async ({ page }) => {
  const id = await open(page);
  await page
    .getByTestId("transcript")
    .locator('[data-message-id="scroll-live"]')
    .evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  await settled(page);
  const reading = await geometry(page);
  expect(reading.bottom).toBeLessThan(64);
  await grow(page, id);
  await receipt("keyboard-reading-geometry", reading, page);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
});

test("returning to the actual bottom by wheel resumes following", async ({ page }) => {
  const id = await open(page);
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  await grow(page, id);
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
});

test("native scrollbar drag near the bottom retains its reading offset during token growth", async ({
  page,
}) => {
  const id = await open(page);
  const { x, y } = await nativeScrollbar(page);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 4, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(20);
  await settled(page);
  const reading = await geometry(page);
  expect(reading.bottom).toBeLessThan(64);
  await grow(page, id);
  await receipt("scrollbar-reading-geometry", reading, page);
});

test("a trusted upward wheel cancels the pending Jump to latest reconciliation in the same event", async ({
  page,
}) => {
  const id = await open(page);
  const transcript = page.getByTestId("transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  await grow(page, id);
  // Capture runs before Transcript's bubbling input handler: start its actual latest action,
  // leaving a pending virtualizer rAF for the trusted wheel to interrupt in this very event.
  await page.evaluate(() => {
    window.addEventListener(
      "wheel",
      (event) => {
        if (!event.isTrusted) throw new Error("Expected native wheel input");
        const latest = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Jump to latest",
        );
        if (!latest) throw new Error("Expected the production latest action");
        latest.click();
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.wheel(0, -0.5);
  await settled(page);
  const reading = await geometry(page);
  await grow(page, id);
  await receipt("pending-latest-reading-geometry", reading, page);
});

test("native smooth scrolling yields to manual upward reading before further token growth", async ({
  page,
}) => {
  const id = await open(page);
  const transcript = page.getByTestId("transcript");
  await transcript.evaluate((el) => el.scrollTo({ top: el.scrollTop - 160, behavior: "smooth" }));
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(20);
  await transcript.hover();
  await page.mouse.wheel(0, -32);
  await settled(page);
  const reading = await geometry(page);
  await grow(page, id);
  await receipt("smooth-takeover-reading-geometry", reading, page);
});

test("live compaction padding preserves paused reading and remains visible when following", async ({
  page,
}) => {
  const id = await open(page);
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  const reading = await geometry(page);
  const height = reading.height;
  await page.evaluate(
    (targetId) =>
      window.gramMock!.simulateStatus(targetId as never, "running", undefined, {
        startedAt: 1000,
        trigger: "auto",
      }),
    id,
  );
  await expect.poll(() => geometry(page).then((g) => g.height)).toBeGreaterThan(height);
  await grow(page, id);
  await receipt("compaction-reading-geometry", reading, page);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
});

test("expanding a completed tool below the reading edge preserves the streamed row offset", async ({
  page,
}) => {
  const id = await open(page);
  await page.evaluate(
    (targetId) =>
      window.gramMock!.simulateChunks(targetId as never, "scroll-live" as never, [
        {
          type: "tool-input-available",
          toolCallId: "scroll-tool",
          toolName: "Bash",
          input: { command: "echo invented" },
        },
        {
          type: "tool-output-available",
          toolCallId: "scroll-tool",
          output: { stdout: "Invented output line.\n".repeat(80), stderr: "", interrupted: false },
        },
      ]),
    id,
  );
  const transcript = page.getByTestId("transcript");
  const tool = transcript.locator('[data-tool-call-id="scroll-tool"] button').first();
  await expect(tool).toBeInViewport();
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  await transcript.hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  // The floating latest control can cover the center; verify the leading area is actionable.
  const point = await tool.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = 16;
    const y = box.height / 2;
    const hit = document.elementFromPoint(box.left + x, box.top + y);
    return { x, y, actionable: hit?.closest("button") === button };
  });
  expect(point.actionable, "the real tool header has an unobscured click point").toBe(true);
  const reading = await geometry(page);
  await tool.click({ position: { x: point.x, y: point.y } });
  await expect(tool).toHaveAttribute("data-panel-open");
  await expect.poll(() => geometry(page).then((g) => g.height)).toBeGreaterThan(reading.height);
  await grow(page, id);
  await receipt("tool-expansion-reading-geometry", reading, page);
});

test("late image preview and reasoning start/end below the reading edge preserve the viewport", async ({
  page,
}) => {
  const id = await open(page);
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  const reading = await geometry(page);
  await page.evaluate((targetId) => {
    const mock = window.gramMock!;
    const read = mock.readAttachment.bind(mock);
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 240;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2563eb";
    context.fillRect(0, 0, 360, 240);
    const base64 = canvas.toDataURL("image/png").split(",")[1]!;
    mock.readAttachment = async (threadId, path) =>
      path === "/mock/scroll.png"
        ? { path, mediaType: "image/png", size: 1024, tooLarge: false, base64 }
        : read(threadId, path);
    mock.simulateChunks(targetId as never, "scroll-live" as never, [
      { type: "file", mediaType: "image/png", url: "file:///mock/scroll.png" },
      { type: "reasoning-start", id: "reason" },
      { type: "reasoning-delta", id: "reason", delta: "Invented reasoning." },
    ]);
  }, id);
  const image = page.getByTestId("transcript").getByTestId("sent-file").getByRole("img");
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalHeight)).toBe(240);
  await expect(page.getByTestId("reasoning-note")).toHaveCount(1);
  await expect
    .poll(() => geometry(page).then((g) => g.height))
    .toBeGreaterThan(reading.height + 200);
  await receipt("image-reasoning-reading-geometry", reading, page);
  await page.evaluate(
    (targetId) =>
      window.gramMock!.simulateChunks(targetId as never, "scroll-live" as never, [
        { type: "reasoning-end", id: "reason" },
      ]),
    id,
  );
  await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
  await grow(page, id);
  await receipt("reasoning-end-reading-geometry", reading, page);
});

test("rapid thread switches retire pending scroll work and restore bottom follow on reentry", async ({
  page,
}) => {
  const id = await open(page);
  // Close the invented stream before reconnecting: simulateChunks does not own replay buffers.
  await page.evaluate(
    (targetId) =>
      window.gramMock!.simulateChunks(targetId as never, "scroll-live" as never, [
        { type: "text-end", id: "text" },
        { type: "finish" },
      ]),
    id,
  );
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -32);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeGreaterThan(25);
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  for (let i = 0; i < 3; i++) {
    await threadRow(page, "t-deps").click();
    await threadRow(page, id).click();
    await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
  }
  // A fresh stream after reentry still follows normally, without reviving the retired target.
  const height = (await geometry(page)).height;
  await page.evaluate(
    (targetId) =>
      window.gramMock!.simulateChunks(targetId as never, "scroll-next" as never, [
        { type: "start", messageId: "scroll-next" },
        { type: "text-start", id: "next" },
        { type: "text-delta", id: "next", delta: "A fresh invented stream.\n\n".repeat(30) },
      ]),
    id,
  );
  await expect.poll(() => geometry(page).then((g) => g.height)).toBeGreaterThan(height);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
});

test("an untouched bottom viewport keeps following each measured token batch", async ({
  page,
}, info) => {
  const id = await open(page);
  const before = await geometry(page);
  await grow(page, id);
  await expect.poll(() => geometry(page).then((g) => g.bottom)).toBeLessThan(2);
  const after = await geometry(page);
  expect(after.top).toBeGreaterThan(before.top + 100);
  await info.attach("following-geometry", {
    body: JSON.stringify({ before, after }),
    contentType: "application/json",
  });
});
