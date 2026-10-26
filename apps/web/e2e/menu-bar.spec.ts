import type { RequestId, TrayAction, TrayMenu } from "@gram/contracts";
import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { openOrchestrator, threadRow } from "./thread-row";

// The menu bar's (tray's) asks. The desktop shell is a fake:
// `window.gram` records each menu the page sends and plays back what the user picks. Nothing here
// reads the host's tray, menu bar or account state.

/** The stack's undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000 * slowdown;
const PUSH = "git push -u origin feat/mail-trigger";
const LONG = `${PUSH} && npm run release -- --tag next --dry-run=false`;

interface Recorded {
  readonly menus: TrayMenu[];
  readonly pick: (action: TrayAction) => void;
  readonly sent: unknown[];
}

const recorded = (page: Page) =>
  page.evaluate(() => {
    const tray = (window as unknown as { tray: Recorded }).tray;
    return { menus: [...tray.menus], sent: [...tray.sent] };
  });

const pick = (page: Page, action: TrayAction) =>
  page.evaluate((a) => (window as unknown as { tray: Recorded }).tray.pick(a), action);

/** The newest menu, once one has `match`. */
const menuWith = async (page: Page, match: (menu: TrayMenu) => boolean) => {
  await expect.poll(async () => match((await recorded(page)).menus.at(-1)!)).toBe(true);
  return (await recorded(page)).menus.at(-1)!;
};

const start = async (page: Page, { trayOn = true } = {}) => {
  await page.addInitScript((on) => {
    const menus: unknown[] = [];
    let onAction: ((action: unknown) => void) | undefined;
    (window as unknown as { tray: unknown }).tray = {
      menus,
      sent: [],
      pick: (action: unknown) => onAction?.(action),
    };
    Object.defineProperty(window, "gram", {
      configurable: true,
      value: {
        platform: "darwin",
        onMenu: () => () => {},
        onNotificationClick: () => () => {},
        notify() {},
        setBadge() {},
        setTitleBarTheme() {},
        setVibrancy() {},
        setMenuShortcuts() {},
        reportConnection() {},
        windowLayout: async () => null,
        setWindowLayout() {},
        listFonts: async () => [],
        openExternal: async () => true,
        copyText: async () => {},
        keepInTray: { get: async () => on, set: async () => {}, onChange: () => () => {} },
        tray: {
          show: (menu: unknown) => menus.push(menu),
          onAction: (callback: (action: unknown) => void) => {
            onAction = callback;
            return () => {
              onAction = undefined;
            };
          },
        },
        updates: {
          autoCheck: async () => false,
          onProgress: () => () => {},
          check: async () => ({
            available: false,
            unavailable: true,
            currentVersion: "0.0.0",
            canSelfInstall: false,
          }),
        },
      },
    });
  }, trayOn);
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  return page.evaluate(() => {
    const mock = window.gramMock!;
    const sent = (window as unknown as { tray: Recorded }).tray.sent;
    const respondMany = mock.respondMany.bind(mock);
    mock.respondMany = (answers) => {
      sent.push(...answers.map((a) => ({ requestId: a.requestId, answer: a.answer })));
      return respondMany(answers);
    };
    return mock.simulateAsks();
  });
};

const hasPush = (menu: TrayMenu) => menu.asks.some((ask) => ask.title === "Allow git push × 3?");

test("Allow in the menu answers the ask through the stack, and it leaves the menu", async ({
  page,
}) => {
  const made = await start(page);
  const menu = await menuWith(page, hasPush);
  const push = menu.asks.find((ask) => ask.title === "Allow git push × 3?")!;
  // The exact command, then Allow for all three.
  expect(push).toMatchObject({ lines: [PUSH], answer: "Allow 3" });
  expect(push.context).toContain("agent-platform");
  // Both workspaces, with their asks counted.
  expect(menu.workspaces.map((w) => w.name)).toEqual(
    expect.arrayContaining(["agent-platform", "billing"]),
  );
  const sentBefore = (await recorded(page)).sent.length;

  await pick(page, { kind: "answer", id: push.id });
  await menuWith(page, (latest) => !hasPush(latest));

  await openOrchestrator(page, made.orchestratorThreadId);
  const stack = page.getByTestId("ask-stack");
  // The stack's own undo line: the same held answer, not a second path.
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await page.waitForTimeout(SENT_MS);
  const answers = (await recorded(page)).sent.slice(sentBefore);
  expect(answers).toHaveLength(3);
  for (const each of answers) {
    expect(each).toMatchObject({ answer: { kind: "approval", decision: "allow", scope: "once" } });
  }

  // The same pick again finds nothing to answer and sends nothing.
  await pick(page, { kind: "answer", id: push.id });
  await page.waitForTimeout(SENT_MS);
  expect((await recorded(page)).sent.length).toBe(sentBefore + 3);
});

test("a command too long for the menu offers Open only, which shows it whole in the stack", async ({
  page,
}) => {
  const made = await start(page);
  await page.evaluate(
    ([threadId, command]) =>
      window.gramMock!.simulateRequest(threadId, {
        kind: "approval",
        id: "r-long" as RequestId,
        toolName: "Bash",
        displayName: "Bash",
        input: { command },
        suggestions: [],
        scopes: ["once"],
      }),
    [made.freeForm.threadId, LONG] as const,
  );
  // Shown as its cut start, as a notification shows it: never as if it were the whole command.
  const cut = `${LONG.slice(0, 37)}…`;
  const isLong = (ask: TrayMenu["asks"][number]) => ask.lines[0] === cut;
  const menu = await menuWith(page, (latest) => latest.asks.some(isLong));
  const long = menu.asks.find(isLong)!;
  expect(long.lines).toEqual([cut]);
  expect(long.answer).toBeUndefined();
  expect(long.title).toBe("Allow git push?");
  // Even a page that asked for an Allow there would have it dropped by the shell
  // (`parseTrayMenu`, packages/shell/src/core/tray-menu.test.ts).

  await pick(page, { kind: "open", id: long.id });
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const current = page
    .getByTestId("ask-stack")
    .locator('li:not([inert]) [data-testid="ask-item"][data-current]');
  await expect(current.getByTestId("ask-command")).toHaveText(LONG);
});

test("the rest of the asks open Quiet, and a workspace opens its orchestrator", async ({
  page,
}) => {
  const made = await start(page);
  const menu = await menuWith(page, hasPush);
  await pick(page, { kind: "asks" });
  await expect(page.getByTestId("quiet-view")).toBeVisible();
  const here = menu.workspaces.find((w) => w.name === "agent-platform")!;
  await pick(page, { kind: "workspace", id: here.id });
  await expect(page.getByTestId("quiet-view")).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
});

test("with the menu bar item off, the page sends no menu", async ({ page }) => {
  await start(page, { trayOn: false });
  await page.waitForTimeout(1_000);
  expect((await recorded(page)).menus).toEqual([]);
});

test("Pause all pauses every workspace, as Quiet's menu does, and the menu then offers Resume all", async ({
  page,
}) => {
  await start(page);
  await menuWith(page, (menu) => menu.allPaused === false && menu.workspaces.length >= 2);

  await pick(page, { kind: "pauseAll", paused: true });
  await menuWith(page, (menu) => menu.allPaused === true);
  // The same state Quiet's menu reads: it now says Resume all too.
  await pick(page, { kind: "asks" });
  await page.getByTestId("quiet-menu").click();
  await expect(page.getByTestId("quiet-menu-popup")).toContainText("Resume all");
  await page.keyboard.press("Escape");

  await pick(page, { kind: "pauseAll", paused: false });
  await menuWith(page, (menu) => menu.allPaused === false);
});
