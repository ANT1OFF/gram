import { expect, test, type Page } from "@playwright/test";
import type { GramUIMessage } from "@gram/contracts";

import { seedTheme } from "./seed-theme";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

const shots = process.env["GRAM_LONG_SHOTS"] ?? "e2e/__screenshots__";
const phase = process.env["GRAM_LONG_PHASE"] ?? "after";
const errors = new WeakMap<Page, string[]>();
declare global {
  interface Window {
    timingFrames?: number;
    timingEvents?: Array<{
      kind: string;
      time: number;
      frame: number;
      trusted?: boolean;
      scroll?: number;
      targetVisible?: boolean;
    }>;
    timingReleasePage?: () => void;
    timingPageCalls?: string[];
    gramNavigationMessages?: GramUIMessage[];
    gramNavigationReplacement?: { threadId: string; messages: GramUIMessage[] } | undefined;
  }
}

test.beforeEach(({ page }) => {
  const observed: string[] = [];
  errors.set(page, observed);
  page.on("pageerror", (error) => observed.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") observed.push(message.text());
  });
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

async function open(page: Page, turns = 120, mode: "light" | "dark" = "dark", height = 1000) {
  await page.setViewportSize({ width: 1600, height });
  await seedTheme(page, { mode, palette: "tokyo-night", motion: "off" });
  await page.addInitScript(() => {
    Object.defineProperty(window, "gramMock", {
      configurable: true,
      set(mock: NonNullable<typeof window.gramMock>) {
        const feed = mock.threadFeed.bind(mock);
        mock.threadFeed = async function* (...args) {
          for await (const event of feed(...args)) {
            const replacement = window.gramNavigationReplacement;
            if (replacement?.threadId === args[0] && event.type === "message") {
              window.gramNavigationReplacement = undefined;
              yield { type: "messages", messages: replacement.messages, earlier: false };
            } else yield event;
          }
        };
        Object.defineProperty(window, "gramMock", {
          configurable: true,
          writable: true,
          value: mock,
        });
      },
    });
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        claudeSignIn: "signedIn",
        codexSignIn: "signedIn",
        ghSignedIn: false,
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
          { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.162.1" },
          { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
          { tool: "gh", found: false },
        ],
      }),
    );
  });
  await page.goto("/");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  const threadId = await page.evaluate(async (turnCount) => {
    const mock = window.gramMock!;
    const [id] = mock.seedLongThreads({ count: 1, turns: 0 });
    await mock.rename(id!, "Synthetic navigation history");
    await mock.setModel(id!, { agent: "codex", model: "gpt-5.5" });
    window.gramNavigationMessages = [];
    for (let i = 0; i < turnCount; i++) {
      const messages: GramUIMessage[] = [
        {
          id: `nav-u${i}`,
          role: "user",
          parts: [{ type: "text", text: `Synthetic decision ${i + 1}` }],
        },
        {
          id: `nav-a${i}`,
          role: "assistant",
          metadata: { agent: "codex" },
          parts: [
            ...(i % 10 === 0
              ? [
                  {
                    type: "data-chapter" as const,
                    data: { id: `chapter-${i}`, title: `Synthetic chapter ${i + 1}` },
                  },
                ]
              : []),
            {
              type: "text",
              text: "An invented explanation for the proposed storage strategy. ".repeat(
                i === turnCount - 1 ? 2 : [2, 600, 30, 120][i % 4]!,
              ),
            },
            {
              type: "tool-Bash",
              toolCallId: `nav-tool${i}`,
              state: "output-available",
              input: { command: "echo synthetic" },
              output: {
                stdout: "Invented tool output. ".repeat(i % 3 === 0 ? 400 : 1),
                stderr: "",
                interrupted: false,
              },
            },
          ],
        },
      ];
      window.gramNavigationMessages.push(...messages);
      for (const message of messages) mock.simulateMessage(id!, message);
    }
    return id!;
  }, turns);
  await threadRow(page, threadId).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  // Wide-rail checks depend on the conversation container, not only the window width.
  await page.getByRole("button", { name: "Hide right panel", exact: true }).click();
  await expect(
    page.getByTestId("transcript").locator(`[data-message-id="nav-a${turns - 1}"]`),
  ).toBeInViewport();
  await expect
    .poll(() =>
      page
        .getByTestId("transcript")
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(3);
  return threadId;
}

async function jump(page: Page, turn: number) {
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page
    .getByTestId("toc")
    .getByRole("menuitem", { name: `Synthetic decision ${turn + 1}`, exact: true })
    .click();
  await expect(
    page.getByTestId("transcript").locator(`[data-message-id="nav-u${turn}"]`),
  ).toBeInViewport();
}

async function geometry(page: Page) {
  return page.getByTestId("transcript").evaluate((el) => ({
    scrollTop: el.scrollTop,
    height: el.scrollHeight,
    client: el.clientHeight,
    rows: [...el.querySelectorAll<HTMLElement>("[data-message-id]")].map((row) => ({
      id: row.dataset.messageId,
      top: row.getBoundingClientRect().top - el.getBoundingClientRect().top,
      height: row.offsetHeight,
    })),
  }));
}

test("unequal paged history repeatedly reaches oldest, middle and newest without a loop", async ({
  page,
}) => {
  await open(page);
  for (const turn of [100, 80, 60, 40, 20, 0, 119, 60, 0, 119, 0]) {
    await jump(page, turn);
    await test.info().attach(`jump-${turn}`, {
      body: JSON.stringify(await geometry(page)),
      contentType: "application/json",
    });
  }
  await expect(page.getByTestId("conversation-rail").getByRole("button")).toHaveCount(132);
  expect(await page.getByTestId("transcript").locator("[data-message-id]").count()).toBeLessThan(
    40,
  );
});

test("late append during a jump keeps its stable target and manual wheel takes control", async ({
  page,
}) => {
  const threadId = await open(page);
  for (const turn of [100, 80, 60, 40, 20, 0]) await jump(page, turn);
  await jump(page, 119);
  for (const turn of [60, 20, 80, 0, 100]) {
    await page.getByRole("button", { name: "Contents", exact: true }).click();
    const item = page
      .getByTestId("toc")
      .getByRole("menuitem", { name: `Synthetic decision ${turn + 1}`, exact: true });
    await item.evaluate((el, id) => {
      (el as HTMLElement).click();
      requestAnimationFrame(() => {
        window.gramMock!.simulateMessage(id as never, {
          id: "nav-late",
          role: "assistant",
          parts: [{ type: "text", text: "An invented late reply. ".repeat(800) }],
        });
      });
    }, threadId);
    await expect(
      page.getByTestId("transcript").locator(`[data-message-id="nav-u${turn}"]`),
    ).toBeInViewport();
    await expect(
      page
        .getByTestId("conversation-rail")
        .getByRole("button", { name: `Synthetic decision ${turn + 1}`, exact: true }),
    ).toHaveAttribute("aria-current", "location");
  }
  const transcript = page.getByTestId("transcript");
  await transcript.hover();
  const beforeWheel = await transcript.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(beforeWheel + 650);
  const before = await transcript.evaluate((el) => el.scrollTop);
  await page.evaluate(
    (id) =>
      window.gramMock!.simulateMessage(id as never, {
        id: "nav-later",
        role: "assistant",
        parts: [{ type: "text", text: "An invented append after manual scrolling. ".repeat(400) }],
      }),
    threadId,
  );
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeLessThan(before + 100);
});

test("pending jump survives a same-count interior history replacement", async ({ page }) => {
  const threadId = await open(page);
  for (const turn of [100, 80, 60, 40, 20, 0]) await jump(page, turn);
  await jump(page, 119);
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page
    .getByTestId("toc")
    .getByRole("menuitem", { name: "Synthetic decision 61", exact: true })
    .evaluate((el, id) => {
      (el as HTMLElement).click();
      requestAnimationFrame(() => {
        const all = window.gramNavigationMessages!;
        // Same endpoints and count, but the chosen turn moves to a different interior index.
        const replacement = [
          ...all.slice(0, 2),
          ...all.slice(100, 160),
          ...all.slice(2, 100),
          ...all.slice(160),
        ];
        window.gramNavigationReplacement = { threadId: id, messages: replacement };
        window.gramMock!.simulateMessage(id as never, {
          id: "replacement-trigger",
          role: "assistant",
          parts: [{ type: "text", text: "Synthetic snapshot trigger" }],
        });
      });
    }, threadId);
  await expect
    .poll(() => page.evaluate(() => window.gramNavigationReplacement === undefined))
    .toBe(true);
  await test.info().attach("replacement-geometry", {
    body: JSON.stringify(await geometry(page)),
    contentType: "application/json",
  });
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="nav-u60"]'),
  ).toBeInViewport();
  await expect(
    page
      .getByTestId("conversation-rail")
      .getByRole("button", { name: "Synthetic decision 61", exact: true }),
  ).toHaveAttribute("aria-current", "location");
});

test("navigation offers bounded older-history continuity without transcript scrolling", async ({
  page,
}) => {
  await open(page);
  const contents = page.getByRole("button", { name: "Contents", exact: true });
  await contents.click();
  const menu = page.getByTestId("toc");
  for (let count = 44; count <= 132; count += 22) {
    await menu
      .getByRole("menuitem", { name: "Load earlier prompts and chapters", exact: true })
      .click();
    await contents.click();
    await expect(menu.getByRole("menuitem", { name: /^Synthetic / })).toHaveCount(count);
  }
  await expect(
    menu.getByRole("menuitem", { name: "Load earlier prompts and chapters", exact: true }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Synthetic decision 1", exact: true }),
  ).toBeAttached();
  await menu.getByRole("menuitem", { name: "Synthetic decision 1", exact: true }).click();
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="nav-u0"]'),
  ).toBeInViewport();
});

for (const mode of ["light", "dark"] as const) {
  for (const turns of [8, 120]) {
    test(`${mode}/${turns}: matched rail captures`, async ({ page }) => {
      await open(page, turns, mode);
      if (turns === 120) {
        for (const turn of [100, 80, 60, 40, 20, 0, 119]) await jump(page, turn);
      }
      await page.mouse.move(0, 0);
      await page.getByLabel("Message", { exact: true }).focus();
      await page.screenshot({ path: `${shots}/${mode}-${turns}.${phase}.png` });
      const rail = page.getByTestId("conversation-rail");
      const railGeometry = await rail.evaluate((el) => {
        const buttons = [...el.querySelectorAll("button")];
        const first = buttons[0]!.getBoundingClientRect();
        const last = buttons.at(-1)!.getBoundingClientRect();
        const viewport = el.parentElement!.getBoundingClientRect();
        return {
          center: (first.top + last.bottom) / 2,
          viewportCenter: (viewport.top + viewport.bottom) / 2,
          pitch: buttons[1]!.getBoundingClientRect().top - first.top,
          viewportHeight: viewport.height,
          listHeight: last.bottom - first.top,
        };
      });
      await test.info().attach("rail-geometry", {
        contentType: "application/json",
        body: JSON.stringify(railGeometry),
      });
      if (phase !== "before") {
        expect(railGeometry.pitch).toBeLessThanOrEqual(24);
        if (railGeometry.listHeight < railGeometry.viewportHeight - 32)
          expect(Math.abs(railGeometry.center - railGeometry.viewportCenter)).toBeLessThan(2);
      }
    });
  }
}

test("overflow keeps current, oldest, newest and real Tab labels reachable", async ({ page }) => {
  await open(page);
  for (const turn of [100, 80, 60, 40, 20, 0, 119]) await jump(page, turn);
  const rail = page.getByTestId("conversation-rail");
  const first = rail.getByRole("button", { name: "Synthetic decision 1", exact: true });
  const last = rail.getByRole("button", { name: "Synthetic decision 120", exact: true });
  await test.info().attach("overflow-geometry", {
    body: JSON.stringify(await geometry(page)),
    contentType: "application/json",
  });
  await expect(last).toHaveAttribute("aria-current", "location");
  await expect(last).toBeInViewport();
  await last.focus();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport();
  await page.keyboard.press("Tab");
  await expect(
    rail.getByRole("button", { name: "Synthetic chapter 1", exact: true }),
  ).toBeFocused();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText(
    "Synthetic chapter 1",
  );
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="nav-u0"]'),
  ).toBeInViewport();
  await expect(first).toHaveAttribute("aria-current", "location");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="nav-u119"]'),
  ).toBeInViewport();
  await expect(last).toHaveAttribute("aria-current", "location");
  const sizes = await last.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
  }));
  expect(sizes).toEqual({ width: 80, height: 24 });
});

for (const touch of [false, true]) {
  test.describe(touch ? "coarse full history" : "narrow full history", () => {
    test.use({ hasTouch: touch });
    test("pages every eligible entry from Contents and returns focus", async ({ page }) => {
      await open(page);
      if (!touch) await setLayout(page, "3 columns");
      await expect(page.getByTestId("conversation-rail")).toBeHidden();
      const contents = page.getByRole("button", { name: "Contents", exact: true });
      const menu = page.getByTestId("toc");
      await contents.click();
      for (let count = 44; count <= 132; count += 22) {
        await menu
          .getByRole("menuitem", { name: "Load earlier prompts and chapters", exact: true })
          .click();
        await expect(contents).toBeFocused();
        await contents.click();
        await expect(menu.getByRole("menuitem", { name: /^Synthetic / })).toHaveCount(count);
      }
      await expect(
        menu.getByRole("menuitem", { name: "Load earlier prompts and chapters", exact: true }),
      ).toHaveCount(0);
      await menu.getByRole("menuitem", { name: "Synthetic decision 1", exact: true }).click();
      await expect(contents).toBeFocused();
      await expect(
        page.getByTestId("transcript").locator('[data-message-id="nav-u0"]'),
      ).toBeInViewport();
      await jump(page, 119);
      await expect(contents).toBeFocused();
      await contents.click();
      await page.keyboard.press("Escape");
      await expect(contents).toBeFocused();
    });
  });
}

test("a repeated nonce jumps again after manual reading; running text and follow-bottom respect the reader", async ({
  page,
}) => {
  const threadId = await open(page);
  await jump(page, 110);
  const transcript = page.getByTestId("transcript");
  const landed = await transcript.evaluate((el) => el.scrollTop);
  await transcript.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(landed + 650);
  await page.evaluate((id) => {
    window.gramMock!.simulateStatus(id as never, "running");
    window.gramMock!.simulateChunks(id as never, "nav-live" as never, [
      { type: "start", messageId: "nav-live" },
      { type: "text-start", id: "nav-live-text" },
      {
        type: "text-delta",
        id: "nav-live-text",
        delta: "An invented running explanation. ".repeat(500),
      },
    ]);
  }, threadId);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await jump(page, 110);
  await expect(transcript.locator('[data-message-id="nav-u110"]')).toBeInViewport();
  const chosen = await geometry(page);
  await page.evaluate(
    (id) =>
      window.gramMock!.simulateChunks(id as never, "nav-live" as never, [
        {
          type: "text-delta",
          id: "nav-live-text",
          delta: "More invented running text. ".repeat(500),
        },
      ]),
    threadId,
  );
  await expect(transcript.locator('[data-message-id="nav-u110"]')).toBeInViewport();
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollTop))
    .toBeLessThan(chosen.scrollTop + 100);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(3);
  await page.evaluate(
    (id) =>
      window.gramMock!.simulateChunks(id as never, "nav-live" as never, [
        { type: "text-delta", id: "nav-live-text", delta: "An invented ending. ".repeat(500) },
        { type: "text-end", id: "nav-live-text" },
        { type: "finish" },
      ]),
    threadId,
  );
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(3);
  await page.evaluate((id) => window.gramMock!.simulateStatus(id as never, "idle"), threadId);
});

test("the wide rail pages earlier entries without losing keyboard focus or the reading position", async ({
  page,
}) => {
  await open(page);
  const rail = page.getByTestId("conversation-rail");
  for (const oldest of [81, 61, 41, 21, 1]) {
    await rail
      .getByRole("button", { name: "Load earlier prompts and chapters", exact: true })
      .click();
    const first = rail.getByRole("button", { name: `Synthetic decision ${oldest}`, exact: true });
    await expect(first).toBeFocused();
    await expect(first).toBeInViewport();
    await expect(
      page.getByTestId("transcript").locator('[data-message-id="nav-u119"]'),
    ).toBeInViewport();
  }
  await expect(rail.getByRole("button")).toHaveCount(132);
  await expect(
    rail.getByRole("button", { name: "Load earlier prompts and chapters", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="nav-u0"]'),
  ).toBeInViewport();
});

test("message stepping and search own their scroll after a conversation jump", async ({ page }) => {
  await open(page);
  await jump(page, 110);
  await page.getByTestId("transcript").locator('[data-message-id="nav-u110"]').focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="nav-a110"]'),
  ).toBeFocused();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByLabel("Find in thread").fill("Synthetic decision 1");
  await expect(page.getByTestId("find-status")).toContainText("of");
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="nav-u0"]'),
  ).toBeInViewport();
});

test("the rail switches at actual 959 and 960 px pane widths", async ({ page }) => {
  await open(page, 8);
  // Fix the overview mode so its automatic breakpoint cannot change the pane-width calculation.
  await page.getByRole("button", { name: "Compact overview", exact: true }).click();
  const transcript = page.getByTestId("transcript");
  const rail = page.getByTestId("conversation-rail");
  const initial = (await transcript.boundingBox())!.width;
  const readingWidth = await transcript.evaluate(
    (el) => el.firstElementChild!.getBoundingClientRect().width,
  );
  await page.setViewportSize({ width: Math.round(1600 + 959 - initial), height: 1000 });
  await expect.poll(async () => (await transcript.boundingBox())!.width).toBe(959);
  await expect(rail).toBeHidden();
  await expect(page.getByRole("button", { name: "Contents", exact: true })).toBeVisible();
  await page.setViewportSize({ width: Math.round(1600 + 960 - initial), height: 1000 });
  await expect.poll(async () => (await transcript.boundingBox())!.width).toBe(960);
  await expect(rail).toBeVisible();
  expect(
    await transcript.evaluate((el) => el.firstElementChild!.getBoundingClientRect().width),
  ).toBe(readingWidth);
  const target = rail.getByRole("button", { name: "Synthetic decision 2", exact: true });
  await target.click({ position: { x: 70, y: 12 } });
  await expect(transcript.locator('[data-message-id="nav-u1"]')).toBeInViewport();
});

test("selected older turn survives a delayed page, live append and viewport reflow", async ({
  page,
}) => {
  const threadId = await open(page);
  await page.evaluate(() => {
    const mock = window.gramMock!;
    const history = mock.threadHistory.bind(mock);
    window.timingPageCalls = [];
    mock.threadHistory = async (...args) => {
      window.timingPageCalls!.push(args[1]);
      if (window.timingPageCalls!.length === 1)
        await new Promise<void>((resolve) => {
          window.timingReleasePage = resolve;
        });
      return history(...args);
    };
  });
  await jump(page, 100);
  const transcript = page.getByTestId("transcript");
  const target = transcript.locator('[data-message-id="nav-u100"]');
  await expect(target).toBeInViewport();
  await expect(
    transcript.getByRole("button", { name: "Loading earlier messages…", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByTestId("conversation-rail")
      .getByRole("button", { name: "Synthetic decision 101", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  const stages = [{ name: "wide-before-page", geometry: await geometry(page) }];
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.evaluate((id) => {
    window.gramMock!.simulateStatus(id as never, "running");
    window.gramMock!.simulateChunks(id as never, "timing-live" as never, [
      { type: "start", messageId: "timing-live" },
      { type: "text-start", id: "timing-text" },
      {
        type: "text-delta",
        id: "timing-text",
        delta: "Invented content during held history paging. ".repeat(600),
      },
    ]);
  }, threadId);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(target).toBeInViewport();
  stages.push({ name: "narrow-held-page-live", geometry: await geometry(page) });
  await page.evaluate(() => window.timingReleasePage!());
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await expect(page.getByTestId("toc").getByRole("menuitem", { name: /^Synthetic / })).toHaveCount(
    44,
  );
  await expect(target).toBeInViewport();
  const calls = await page.evaluate(() => window.timingPageCalls);
  expect(calls).toEqual(["nav-u100"]);
  await page.getByTestId("toc").press("Escape");
  stages.push({ name: "narrow-page-complete", geometry: await geometry(page) });
  await page.setViewportSize({ width: 1600, height: 1000 });
  stages.push({ name: "wide-return", geometry: await geometry(page) });
  await test
    .info()
    .attach("reflow-stages", { body: JSON.stringify(stages), contentType: "application/json" });
  await expect(target).toBeInViewport();
  await expect(
    page
      .getByTestId("conversation-rail")
      .getByRole("button", { name: "Synthetic decision 101", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await test.info().attach("held-page-geometry", {
    body: JSON.stringify({ calls, geometry: await geometry(page) }),
    contentType: "application/json",
  });
});

test("manual wheel during held paging is retained when the earlier page completes", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const mock = window.gramMock!;
    const history = mock.threadHistory.bind(mock);
    window.timingPageCalls = [];
    mock.threadHistory = async (...args) => {
      window.timingPageCalls!.push(args[1]);
      if (window.timingPageCalls!.length === 1)
        await new Promise<void>((resolve) => {
          window.timingReleasePage = resolve;
        });
      return history(...args);
    };
  });
  await jump(page, 100);
  const transcript = page.getByTestId("transcript");
  await expect(
    transcript.getByRole("button", { name: "Loading earlier messages…", exact: true }),
  ).toBeDisabled();
  const before = await transcript.evaluate((el) => el.scrollTop);
  await transcript.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 650);
  const beforePage = await geometry(page);
  const first = beforePage.rows.find((row) => row.top + row.height > 0)!;
  await page.evaluate(() => window.timingReleasePage!());
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await expect(page.getByTestId("toc").getByRole("menuitem", { name: /^Synthetic / })).toHaveCount(
    44,
  );
  const afterPage = await geometry(page);
  const same = afterPage.rows.find((row) => row.id === first.id)!;
  expect(same).toBeDefined();
  expect(Math.abs(same.top - first.top)).toBeLessThan(3);
  expect(await page.evaluate(() => window.timingPageCalls)).toEqual(["nav-u100"]);
  await page.getByTestId("toc").press("Escape");
  const oldTarget = transcript.locator('[data-message-id="nav-u100"]');
  await expect(oldTarget).not.toBeInViewport();
  for (const width of [1200, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(oldTarget).not.toBeInViewport();
    await expect
      .poll(async () => {
        const row = (await geometry(page)).rows.find((candidate) => candidate.id === first.id);
        return row ? Math.abs(row.top - first.top) : Infinity;
      })
      .toBeLessThan(3);
  }
  await test.info().attach("manual-prepend-anchor", {
    body: JSON.stringify({ beforePage, afterPage }),
    contentType: "application/json",
  });
});

async function observeFrames(page: Page) {
  await page.evaluate(() => {
    window.timingFrames = 0;
    window.timingEvents = [];
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page context
    const frame = () => {
      window.timingFrames!++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]')!;
    transcript.addEventListener(
      "wheel",
      (event) =>
        window.timingEvents!.push({
          kind: "wheel",
          time: performance.now(),
          frame: window.timingFrames!,
          trusted: event.isTrusted,
          scroll: transcript.scrollTop,
          targetVisible: (() => {
            const target = transcript.querySelector('[data-message-id="nav-u110"]');
            if (!target) return false;
            const row = target.getBoundingClientRect(),
              view = transcript.getBoundingClientRect();
            return row.bottom > view.top && row.top < view.bottom;
          })(),
        }),
      { once: true },
    );
  });
}

test("trusted wheel during the unsettled jump wins over a late append", async ({ page }) => {
  const threadId = await open(page);
  // Measure the target through production navigation before timing input delivery. Cold row
  // rendering can otherwise consume the entire takeover window before a native wheel arrives.
  await jump(page, 110);
  await jump(page, 119);
  const transcript = page.getByTestId("transcript");
  const box = (await transcript.boundingBox())!;
  await observeFrames(page);
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page
    .getByTestId("toc")
    .getByRole("menuitem", { name: "Synthetic decision 111", exact: true })
    .evaluate(async (el) => {
      window.timingEvents?.push({
        kind: "jump",
        time: performance.now(),
        frame: window.timingFrames ?? 0,
      });
      (el as HTMLElement).click();
      // Concurrent protocol calls can deliver the wheel before React applies the jump. Await
      // the required target in this same call, retaining the takeover-window assertion below.
      await new Promise<void>((resolve) => {
        const ready = () => {
          const row = document.querySelector('[data-message-id="nav-u110"]');
          const view = document.querySelector('[data-testid="transcript"]');
          const bounds = row?.getBoundingClientRect();
          const viewport = view?.getBoundingClientRect();
          if (bounds && viewport && bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
            window.timingEvents?.push({
              kind: "visible",
              time: performance.now(),
              frame: window.timingFrames ?? 0,
            });
            resolve();
          } else requestAnimationFrame(ready);
        };
        ready();
      });
    });
  await page.mouse.wheel(0, 700);
  const target = transcript.locator('[data-message-id="nav-u110"]');
  await expect
    .poll(() => page.evaluate(() => window.timingEvents?.find((e) => e.kind === "wheel")?.trusted))
    .toBe(true);
  const timing = await page.evaluate(() => window.timingEvents!);
  const visible = timing.find((e) => e.kind === "visible")!;
  const wheel = timing.find((e) => e.kind === "wheel")!;
  await test.info().attach("trusted-wheel-timing", {
    body: JSON.stringify(timing),
    contentType: "application/json",
  });
  expect(wheel.targetVisible).toBe(true);
  // The jump settles once its target has held still for four frames, and it can't hold still
  // there before it is visible: a wheel fewer than four frames after that is inside the takeover
  // window. Counted from there, not from the click: frames a slow renderer spends reaching the
  // target are no part of the window.
  expect(wheel.frame - visible.frame).toBeLessThan(4);
  await expect(target).not.toBeInViewport();
  const manual = await geometry(page);
  await page.evaluate(
    (id) =>
      window.gramMock!.simulateMessage(id as never, {
        id: "timing-late",
        role: "assistant",
        parts: [
          { type: "text", text: "An invented late append after trusted wheel input. ".repeat(600) },
        ],
      }),
    threadId,
  );
  await expect(target).not.toBeInViewport();
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollTop))
    .toBeLessThan(manual.scrollTop + 100);
  await test.info().attach("manual-position-after-append", {
    body: JSON.stringify(await geometry(page)),
    contentType: "application/json",
  });
});

test("an earlier rail page preserves later composer focus and text", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const mock = window.gramMock!;
    const history = mock.threadHistory.bind(mock);
    window.timingPageCalls = [];
    mock.threadHistory = async (...args) => {
      window.timingPageCalls!.push(args[1]);
      await new Promise<void>((resolve) => {
        window.timingReleasePage = resolve;
      });
      return history(...args);
    };
  });
  const rail = page.getByTestId("conversation-rail");
  await rail
    .getByRole("button", { name: "Load earlier prompts and chapters", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    rail.getByRole("button", { name: "Loading earlier prompts and chapters…", exact: true }),
  ).toBeDisabled();
  const composer = page.getByLabel("Message", { exact: true });
  await composer.click();
  await composer.fill("Continue typing while one page arrives");
  await page.evaluate(() => window.timingReleasePage!());
  await expect(
    rail.getByRole("button", { name: "Synthetic decision 81", exact: true }),
  ).toBeAttached();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Continue typing while one page arrives");
  expect(await page.evaluate(() => window.timingPageCalls)).toEqual(["nav-u100"]);
});

test("the current marker distinguishes the actual bottom from a 50 px reading edge", async ({
  page,
}) => {
  // A transcript 739 px tall puts the reading edge 50 px up well inside turn 6's prompt.
  await open(page, 8, "dark", 960);
  const transcript = page.getByTestId("transcript");
  const current = page.getByTestId("conversation-rail").locator('[aria-current="location"]');
  await expect(current).toHaveAttribute("data-outline-anchor", "nav-u7");
  await transcript.hover();
  await page.mouse.wheel(0, -50);
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBe(50);
  await expect(current).toHaveAttribute("data-outline-anchor", "nav-u6");
  await transcript.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(1.5);
  await expect(current).toHaveAttribute("data-outline-anchor", "nav-u7");
});

test("height resize keeps the current rail mark visible and composer focus intact", async ({
  page,
}) => {
  const id = await open(page);
  for (const turn of [100, 80, 60, 40, 20, 0, 119]) await jump(page, turn);
  await page.evaluate(
    (threadId) =>
      window.gramMock!.simulateMessage(threadId as never, {
        id: "nav-a119",
        role: "assistant",
        metadata: { agent: "codex" },
        parts: [{ type: "text", text: "Invented long newest reply. ".repeat(2000) }],
      }),
    id,
  );
  const transcript = page.getByTestId("transcript");
  // Following requires an explicit return action, not a bare programmatic/layout scroll.
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(1.5);
  const current = page
    .getByTestId("conversation-rail")
    .getByRole("button", { name: "Synthetic decision 120", exact: true });
  await expect(current).toHaveAttribute("aria-current", "location");
  await current.focus();
  await expect(current).toBeInViewport();
  const composer = page.getByLabel("Message", { exact: true });
  await composer.focus();
  await page.setViewportSize({ width: 1600, height: 700 });
  await expect.poll(() => transcript.evaluate((el) => el.clientHeight)).toBeLessThan(600);
  await expect(current).toHaveAttribute("aria-current", "location");
  await expect(current).toBeInViewport();
  await expect(composer).toBeFocused();
});

test("height resize preserves a distinct rail keyboard owner without scrolling the transcript", async ({
  page,
}) => {
  await open(page);
  for (const turn of [100, 80, 60, 40, 20, 0, 60]) await jump(page, turn);
  const transcript = page.getByTestId("transcript");
  const focused = page
    .getByTestId("conversation-rail")
    .getByRole("button", { name: "Synthetic decision 50", exact: true });
  await focused.focus();
  await expect(focused).toBeInViewport();
  const before = await transcript.evaluate((el) => el.scrollTop);
  await page.setViewportSize({ width: 1600, height: 700 });
  await expect(focused).toBeFocused();
  await expect(focused).toBeInViewport();
  await expect
    .poll(() => transcript.evaluate((el, offset) => Math.abs(el.scrollTop - offset), before))
    .toBeLessThan(1.5);
});
