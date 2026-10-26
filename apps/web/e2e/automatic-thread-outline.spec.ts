import { expect, test, type Page } from "@playwright/test";
import type { GramUIMessage } from "@gram/contracts";

import { seedTheme } from "./seed-theme";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

declare global {
  interface Window {
    gramOutlineReplacement?: GramUIMessage[];
  }
}

const phase = process.env["GRAM_OUTLINE_PHASE"] ?? "after";
const shots = process.env["GRAM_OUTLINE_SHOTS"] ?? "e2e/__screenshots__";
const errors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const observed: string[] = [];
  errors.set(page, observed);
  page.on("pageerror", (error) => observed.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") observed.push(message.text());
  });
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

// Invented prompts only, with explicit CLI/account state. No agent process is started.
async function seed(
  page: Page,
  sourceProvider: "claude" | "codex",
  turnCount = 8,
  mode: "light" | "dark" = "dark",
) {
  await seedTheme(page, { mode, palette: "tokyo-night", motion: "off" });
  await page.addInitScript(
    ({ provider, turns }) => {
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
      const prompts = [
        "Choose a storage format",
        "Compare SQLite and plain files",
        "Record the migration decision",
        "Plan rollback",
        "Review the test strategy",
        "Check accessibility",
        "Summarize the tradeoffs",
        "Prepare the implementation",
      ];
      const messages = Array.from({ length: turns }, (_, i) => [
        {
          id: `prompt-${i}`,
          role: "user",
          parts: [{ type: "text", text: prompts[i] ?? `Discuss decision ${i + 1}` }],
        },
        {
          id: `reply-${i}`,
          role: "assistant",
          metadata: { agent: provider },
          parts: [
            {
              type: "text",
              text: `Decision ${i + 1}: keep the implementation small.\n\n${"This synthetic discussion records the reasons and next steps. ".repeat(8)}`,
            },
          ],
        },
      ]).flat();
      Object.defineProperty(window, "gramMock", {
        configurable: true,
        set(mock: NonNullable<typeof window.gramMock>) {
          const original = mock.threadFeed.bind(mock);
          mock.threadFeed = async function* (...args) {
            for await (const event of original(...args)) {
              if (
                window.gramOutlineReplacement &&
                (event.type === "messages" || event.type === "resumed")
              ) {
                yield { type: "messages", messages: window.gramOutlineReplacement, earlier: false };
              } else {
                yield args[0] === "t-deps" && event.type === "messages"
                  ? { ...event, messages: messages as never, earlier: false }
                  : event;
              }
            }
          };
          Object.defineProperty(window, "gramMock", {
            value: mock,
            writable: true,
            configurable: true,
          });
        },
      });
    },
    { provider: sourceProvider, turns: turnCount },
  );
}

// Explicit visual baseline is the provisional Hint-only source, not shipped main.
// Common interaction assertions stay the same; rest-style assertions name each source's design.
if (phase !== "before") {
  for (const provider of ["claude", "codex"] as const) {
    for (const mode of ["dark", "light"] as const) {
      test(`${provider}/${mode}: quiet rail keeps hover, keyboard and current location discoverable`, async ({
        page,
      }) => {
        const visualPhase = process.env["GRAM_OUTLINE_VISUAL_PHASE"] ?? "after";
        const before = visualPhase === "before";
        await page.setViewportSize({ width: 1600, height: 1000 });
        await seed(page, provider, 8, mode);
        await page.goto("/t/t-deps");
        await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Hide right panel", exact: true }).click();
        await page.evaluate(async (fixtureProvider) => {
          await window.gramMock!.rename("t-deps" as never, "Synthetic storage decisions");
          await window.gramMock!.setModel("t-deps" as never, {
            agent: fixtureProvider,
            model: fixtureProvider === "claude" ? "opus" : "gpt-5.5",
          });
        }, provider);
        const rail = page.getByRole("navigation", { name: "Loaded conversation" });
        const contents = page.getByRole("button", { name: "Contents", exact: true });
        const transcript = page.getByTestId("transcript");
        const hint = page.locator('[data-slot="tooltip-content"][data-open]');
        const first = rail.getByRole("button", { name: "Choose a storage format", exact: true });
        const second = rail.getByRole("button", {
          name: "Compare SQLite and plain files",
          exact: true,
        });
        const capture = (state: string) =>
          page.screenshot({
            path: `${shots}/quiet-${provider}-${mode}-${state}.${visualPhase}.png`,
          });
        await expect(rail).toBeVisible();
        await expect(rail.getByRole("button")).toHaveCount(8);
        await expect(rail.locator('[aria-current="location"]')).toHaveCount(1);
        await page.mouse.move(0, 0);
        await page.getByLabel("Message", { exact: true }).focus();
        await expect(hint).toHaveCount(0);
        const rest = await rail.evaluate((el) => {
          const current = el.querySelector<HTMLElement>('[aria-current="location"]')!;
          const other = el.querySelector<HTMLElement>("button:not([aria-current])")!;
          const readingColumn = el.parentElement!.querySelector(
            '[data-testid="transcript"]',
          )!.firstElementChild!;
          return {
            text: (el as HTMLElement).innerText,
            icons: el.querySelectorAll("svg").length,
            width: other.getBoundingClientRect().width,
            height: other.getBoundingClientRect().height,
            railRight: el.getBoundingClientRect().right,
            readingLeft: readingColumn.getBoundingClientRect().left,
            currentBackground: getComputedStyle(current).backgroundColor,
            otherBackground: getComputedStyle(other).backgroundColor,
            currentMarkWidth: current.firstElementChild!.getBoundingClientRect().width,
            otherMarkWidth: other.firstElementChild!.getBoundingClientRect().width,
            currentMarkColor: getComputedStyle(current.firstElementChild!).backgroundColor,
            otherMarkColor: getComputedStyle(other.firstElementChild!).backgroundColor,
          };
        });
        expect(rest.height).toBe(24);
        expect(rest.width).toBeGreaterThanOrEqual(80);
        expect(rest.railRight).toBeLessThanOrEqual(rest.readingLeft);
        if (before) {
          expect(rest.text).toContain("Contents");
          expect(rest.icons).toBe(8);
          expect(rest.currentBackground).not.toBe(rest.otherBackground);
        } else {
          expect(rest.text).toBe("");
          expect(rest.icons).toBe(0);
          expect(rest.currentBackground).toBe("rgba(0, 0, 0, 0)");
          expect(rest.otherBackground).toBe(rest.currentBackground);
          expect(rest.currentMarkWidth).toBeGreaterThan(rest.otherMarkWidth);
          expect(rest.currentMarkColor).not.toBe(rest.otherMarkColor);
          expect(rest.otherMarkWidth).toBeLessThanOrEqual(12);
        }
        await capture("wide-rest");
        await second.hover();
        await expect(hint).toHaveText("Compare SQLite and plain files");
        await capture("wide-hover");
        await page.mouse.move(0, 0);
        await expect(hint).toHaveCount(0);
        await first.focus();
        await page.keyboard.press("Tab");
        await expect(second).toBeFocused();
        await expect(hint).toHaveText("Compare SQLite and plain files");
        const focus = await second.evaluate((el) => ({
          outline: getComputedStyle(el).outlineStyle,
          width: Number.parseFloat(getComputedStyle(el).outlineWidth),
          markWidth: el.firstElementChild!.getBoundingClientRect().width,
        }));
        expect(focus.outline).toBe("solid");
        expect(focus.width).toBeGreaterThanOrEqual(2);
        if (!before) expect(focus.markWidth).toBeGreaterThan(rest.otherMarkWidth);
        await capture("wide-focus");
        await second.press("Enter");
        await expect(transcript.locator('[data-message-id="prompt-1"]')).toBeInViewport();
        await expect(second).toHaveAttribute("aria-current", "location");
        await page.getByLabel("Message", { exact: true }).focus();
        await expect(hint).toHaveCount(0);
        await capture("wide-current");
        await setLayout(page, "3 columns");
        await expect(rail).toBeHidden();
        await expect(contents).toBeVisible();
        expect((await contents.boundingBox())!.width).toBeGreaterThanOrEqual(28);
        await capture("narrow-rest");
        await contents.hover();
        await expect(hint).toHaveText("Contents · loaded prompts and chapters");
        await capture("narrow-hover");
        await page.mouse.move(0, 0);
        await expect(hint).toHaveCount(0);
        await contents.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(contents).toBeFocused();
        await expect(hint).toHaveText("Contents · loaded prompts and chapters");
        await capture("narrow-focus");
        await contents.press("Enter");
        const menu = page.getByTestId("toc");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem")).toHaveCount(8);
        await expect(menu.getByText("Loaded prompts and chapters", { exact: true })).toBeVisible();
        await capture("narrow-menu");
        await menu.press("Escape");
        await expect(menu).toBeHidden();
        await expect(contents).toBeFocused();
        await expect(hint).toHaveText("Contents · loaded prompts and chapters");
        expect(page.viewportSize()).toEqual({ width: 1600, height: 1000 });
      });
    }
  }
}

if (phase !== "before") {
  test.describe("touch", () => {
    test.use({ hasTouch: true });
    test("keeps Contents accessible without a hover rail", async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await seed(page, "codex");
      await page.goto("/t/t-deps");
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
      await expect(page.getByTestId("conversation-rail")).toBeHidden();
      await page.getByRole("button", { name: "Contents", exact: true }).tap();
      await page
        .getByTestId("toc")
        .getByRole("menuitem", { name: "Choose a storage format", exact: true })
        .tap();
      await expect(
        page.getByTestId("transcript").locator('[data-message-id="prompt-0"]'),
      ).toBeInViewport();
      await page.screenshot({ path: `${shots}/outline-touch.after.png` });
    });
  });
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: ordinary prompts become navigable, including keyboard and repeated jumps`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await seed(page, provider);
    await page.goto("/t/t-deps");
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Hide right panel", exact: true }).click();
    await page.evaluate(async (fixtureProvider) => {
      await window.gramMock!.rename("t-deps" as never, "Synthetic storage decisions");
      await window.gramMock!.setModel("t-deps" as never, {
        agent: fixtureProvider,
        model: fixtureProvider === "claude" ? "opus" : "gpt-5.5",
      });
    }, provider);
    const contents = page.getByRole("button", { name: "Contents", exact: true });
    const transcript = page.getByTestId("transcript");
    await expect(transcript.locator('[data-message-id="prompt-7"]')).toBeVisible();
    if (phase === "before") {
      await expect(contents).toHaveCount(0);
      await page.screenshot({ path: `${shots}/outline-${provider}-wide.before.png` });
      return;
    }
    await expect(contents).toBeVisible();
    await expect(
      page.getByTestId("conversation-rail").locator('[aria-current="location"]'),
    ).toHaveCount(1);
    await page.screenshot({ path: `${shots}/outline-${provider}-wide.after.png` });
    await contents.click();
    const menu = page.getByTestId("toc");
    await expect(menu.getByRole("menuitem")).toHaveCount(8);
    await menu.getByRole("menuitem", { name: "Choose a storage format", exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(transcript.locator('[data-message-id="prompt-0"]')).toBeInViewport();
    await expect(contents).toBeFocused();
    await contents.press("ArrowDown");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(contents).toBeFocused();
    await expect(transcript.locator('[data-message-id="prompt-1"]')).toBeInViewport();
    await contents.click();
    await expect(menu).toBeVisible();
    await menu.press("Escape");
    await expect(menu).toBeHidden();
    await expect(contents).toBeFocused();
    await contents.click();
    await menu.getByRole("menuitem", { name: "Choose a storage format", exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(transcript.locator('[data-message-id="prompt-0"]')).toBeInViewport();
    const rail = page.getByRole("navigation", { name: "Loaded conversation" });
    await expect(rail).toBeVisible();
    const active = rail.getByRole("button", { name: "Choose a storage format", exact: true });
    await expect(active).toHaveAttribute("aria-current", "location");
    const currentTone = await rail.evaluate((el) => {
      const selected = el.querySelector('[aria-current="location"]')!;
      const other = el.querySelector("button:not([aria-current])")!;
      return {
        selected: getComputedStyle(selected.firstElementChild!).backgroundColor,
        other: getComputedStyle(other.firstElementChild!).backgroundColor,
        selectedWidth: selected.firstElementChild!.getBoundingClientRect().width,
        otherWidth: other.firstElementChild!.getBoundingClientRect().width,
      };
    });
    expect(currentTone.selected).not.toBe(currentTone.other);
    expect(currentTone.selectedWidth).toBeGreaterThan(currentTone.otherWidth);
    await active.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText(
      "Choose a storage format",
    );
    await active.focus();
    await page.keyboard.press("Tab");
    await expect(
      rail.getByRole("button", { name: "Compare SQLite and plain files", exact: true }),
    ).toBeFocused();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText(
      "Compare SQLite and plain files",
    );
    await rail
      .getByRole("button", { name: "Record the migration decision", exact: true })
      .press("Enter");
    await expect(transcript.locator('[data-message-id="prompt-2"]')).toBeInViewport();
    const wide = await transcript.boundingBox();
    // Same window, real grid controls: container width determines whether the gutter exists.
    await setLayout(page, "3 columns");
    await expect(rail).toBeHidden();
    expect((await transcript.boundingBox())!.width).toBeLessThan(wide!.width / 2);
    await contents.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText(
      "Contents · loaded prompts and chapters",
    );
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveCount(0);
    await contents.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(contents).toBeFocused();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText(
      "Contents · loaded prompts and chapters",
    );
    await contents.click();
    await expect(
      menu.getByRole("menuitem", { name: "Record the migration decision", exact: true }),
    ).toBeVisible();
    await expect(menu).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `${shots}/outline-${provider}-narrow.after.png` });
    await menu.press("Escape");
    await setLayout(page, "1 pane");
    await expect(rail).toBeVisible();
    expect(page.viewportSize()!.width).toBe(1600);
  });
}

if (phase !== "before") {
  for (const provider of ["claude", "codex"] as const) {
    test(`${provider}: virtualized history prepends while Contents is open, streaming stays at the chosen turn, fork and resume remain independent`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await seed(page, provider);
      await page.goto("/");
      await expect(threadRow(page, "t-deps")).toBeVisible();
      const threadId = await page.evaluate(async (fixtureProvider) => {
        const mock = window.gramMock!;
        const [id] = mock.seedLongThreads({ count: 1, turns: 0 });
        await mock.setModel(id!, {
          agent: fixtureProvider,
          model: fixtureProvider === "claude" ? "opus" : "gpt-5.5",
        });
        for (let i = 0; i < 100; i++) {
          const messages: GramUIMessage[] = [
            {
              id: `long-u${i}`,
              role: "user",
              parts: [
                { type: "text", text: `Decision ${i + 1}: choose the simplest storage plan` },
              ],
            },
            {
              id: `long-a${i}`,
              role: "assistant",
              metadata: { agent: fixtureProvider, agentMessageIds: [`native-${i}`] },
              parts: [{ type: "text", text: "Synthetic reasons for this decision. ".repeat(20) }],
            },
          ];
          for (const message of messages) mock.simulateMessage(id!, message);
        }
        return id!;
      }, provider);
      await threadRow(page, threadId).click();
      const transcript = page.getByTestId("transcript");
      const contents = page.getByRole("button", { name: "Contents", exact: true });
      const menu = page.getByTestId("toc");
      await expect(transcript.locator('[data-message-id="long-u99"]')).toBeInViewport();
      expect(await transcript.locator("[data-message-id]").count()).toBeLessThan(40);
      await contents.click();
      await expect(menu.getByRole("menuitem", { name: /^Decision / })).toHaveCount(20);
      // Jumping to the oldest loaded turn itself triggers a prepend during jump reconciliation.
      await menu
        .getByRole("menuitem", {
          name: "Decision 81: choose the simplest storage plan",
          exact: true,
        })
        .click();
      await expect(menu).toBeHidden();
      await contents.click();
      await expect(menu.getByRole("menuitem", { name: /^Decision / })).toHaveCount(40);
      await test.info().attach("prepend-geometry", {
        contentType: "application/json",
        body: JSON.stringify(
          await transcript.evaluate((el) => ({
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            top: el.getBoundingClientRect().top,
            rows: Array.from(el.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => ({
              id: row.dataset.messageId,
              index: row.dataset.index,
              top: row.getBoundingClientRect().top,
              height: row.offsetHeight,
              transform: row.style.transform,
            })),
          })),
        ),
      });
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
      // Then prepend another page while the menu remains open, preserving the row at the top.
      await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
      await expect(menu.getByRole("menuitem", { name: /^Decision / })).toHaveCount(60);
      await expect(transcript.locator('[data-message-id="long-u60"]')).toBeInViewport();
      await menu
        .getByRole("menuitem", {
          name: "Decision 81: choose the simplest storage plan",
          exact: true,
        })
        .click();
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
      // Ongoing adapter text goes through the production feed fold, never a paid turn.
      await page.evaluate((id) => {
        const mock = window.gramMock!;
        mock.simulateStatus(id as never, "running");
        mock.simulateChunks(id as never, "live-reply" as never, [
          { type: "start", messageId: "live-reply" },
          { type: "text-start", id: "live-text" },
          { type: "text-delta", id: "live-text", delta: "Synthetic streaming text. ".repeat(100) },
        ]);
      }, threadId);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
      await page.evaluate((id) => {
        window.gramMock!.simulateChunks(id as never, "live-reply" as never, [
          { type: "text-delta", id: "live-text", delta: "Additional streaming text. ".repeat(100) },
          { type: "text-end", id: "live-text" },
          { type: "finish" },
        ]);
        window.gramMock!.simulateStatus(id as never, "idle");
      }, threadId);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
      await contents.click();
      await menu
        .getByRole("menuitem", {
          name: "Decision 81: choose the simplest storage plan",
          exact: true,
        })
        .click();
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
      await page.evaluate(() => window.gramMock!.simulateDisconnect());
      await expect(contents).toBeVisible();
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
      const fork = await page.evaluate(
        async (id) =>
          window.gramMock!.forkThread(id as never, {
            fromMessageId: "long-a80" as never,
            title: "Synthetic fork at decision 81",
          }),
        threadId,
      );
      await threadRow(page, fork.id).click();
      await contents.click();
      await expect(
        menu.getByRole("menuitem", {
          name: "Decision 81: choose the simplest storage plan",
          exact: true,
        }),
      ).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /Decision 100:/ })).toHaveCount(0);
      await menu
        .getByRole("menuitem", {
          name: "Decision 81: choose the simplest storage plan",
          exact: true,
        })
        .click();
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
      // Removing the selected anchor removes its menu entry; returning to the parent retains it.
      await page.evaluate(
        (id) => window.gramMock!.rewind(id as never, "long-u80" as never, false),
        fork.id,
      );
      await contents.click();
      await expect(menu.getByRole("menuitem", { name: /Decision 81:/ })).toHaveCount(0);
      await menu.press("Escape");
      await threadRow(page, threadId).click();
      await contents.click();
      await menu
        .getByRole("menuitem", {
          name: "Decision 81: choose the simplest storage plan",
          exact: true,
        })
        .click();
      await expect(transcript.locator('[data-message-id="long-u80"]')).toBeInViewport();
    });
  }

  test("explicit chapters coexist with prompts; children, attachments and hidden data do not become labels", async ({
    page,
  }) => {
    await seed(page, "codex");
    await page.goto("/");
    await expect(threadRow(page, "t-deps")).toBeVisible();
    const threadId = await page.evaluate(() => {
      const mock = window.gramMock!;
      const [id] = mock.seedLongThreads({ count: 1, turns: 0 });
      const messages: GramUIMessage[] = [
        { id: "empty", role: "user", parts: [{ type: "text", text: "\n " }] },
        {
          id: "file",
          role: "user",
          parts: [
            {
              type: "file",
              filename: "HIDDEN_FILENAME",
              url: "file:///HIDDEN_PATH",
              mediaType: "text/plain",
            },
          ],
        },
        {
          id: "chapter",
          role: "user",
          parts: [
            { type: "text", text: "Do not duplicate this prompt" },
            { type: "data-chapter", data: { id: "ch", title: "Explicit storage chapter" } },
          ],
        },
        {
          id: "child",
          role: "user",
          metadata: { parentToolUseId: "task" },
          parts: [
            { type: "text", text: "HIDDEN_CHILD" },
            { type: "data-chapter", data: { id: "child-ch", title: "HIDDEN_CHILD_CHAPTER" } },
          ],
        },
        { id: "nontext", role: "user", parts: [{ type: "data-session-restart", data: { at: 1 } }] },
        {
          id: "literal",
          role: "user",
          parts: [{ type: "text", text: '<img src=x onerror="attack()"> Choose plain text' }],
        },
        {
          id: "reply",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "HIDDEN_REASONING" },
            { type: "text", text: "HIDDEN_REPLY" },
          ],
        },
        {
          id: "server-notice",
          role: "user",
          parts: [
            {
              type: "data-review-notice",
              data: { kind: "review", number: 1, blockers: [], suggestions: [], ciFailed: [] },
            },
            { type: "text", text: "HIDDEN_AGENT_CONTEXT" },
          ],
        },
      ];
      for (const message of messages) mock.simulateMessage(id!, message);
      return id!;
    });
    await threadRow(page, threadId).click();
    const contents = page.getByRole("button", { name: "Contents", exact: true });
    await contents.click();
    const menu = page.getByTestId("toc");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Empty prompt",
      "Attachment prompt",
      "Explicit storage chapter",
      "Non-text prompt",
      '<img src=x onerror="attack()"> Choose plain text',
    ]);
    await expect(menu).not.toContainText("HIDDEN");
    await expect(menu.locator("img")).toHaveCount(0);
    // A full snapshot with a new order, as a replaced history on reconnect would provide.
    await menu.press("Escape");
    await page.evaluate(() => {
      const mock = window.gramMock!;
      window.gramOutlineReplacement = [
        { id: "literal", role: "user", parts: [{ type: "text", text: "Moved decision" }] },
        { id: "newer", role: "user", parts: [{ type: "text", text: "New decision" }] },
      ];
      mock.simulateDisconnect();
    });
    await contents.click();
    await expect(menu.getByRole("menuitem")).toHaveText(["Moved decision", "New decision"]);
    await menu.getByRole("menuitem", { name: "Moved decision", exact: true }).click();
    await expect(
      page.getByTestId("transcript").locator('[data-message-id="literal"]'),
    ).toBeInViewport();
  });
}
