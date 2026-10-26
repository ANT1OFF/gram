import type { DesktopNotification, DesktopNotificationAction, RequestId } from "@gram/contracts";
import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { openOrchestrator, threadRow } from "./thread-row";

// Asks as desktop notifications while the window is away.
// The desktop shell is a fake: `window.gram` records what would be shown and plays back what the
// user does with it. The window reports no focus, whatever the host's own state, and nothing here
// reads the host's notification permission.

const MOCK_SETTINGS_KEY = "gram.mock.settings";
/** Past the app's startup grace (`STARTUP_GRACE_MS`), when asks start to be news. */
const AFTER_GRACE_MS = 5_500;
/** The stack's undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000 * slowdown;
const PUSH = "git push -u origin feat/mail-trigger";
const LONG = `${PUSH} && npm run release -- --tag next --dry-run=false`;

interface Recorded {
  readonly notes: DesktopNotification[];
  readonly withdrawn: string[];
  readonly act: (action: DesktopNotificationAction) => void;
  readonly sent: unknown[];
}

const recorded = (page: Page) =>
  page.evaluate(() => {
    const away = (window as unknown as { away: Recorded }).away;
    return { notes: [...away.notes], withdrawn: [...away.withdrawn], sent: [...away.sent] };
  });

const act = (page: Page, action: DesktopNotificationAction) =>
  page.evaluate((a) => (window as unknown as { away: Recorded }).away.act(a), action);

const start = async (page: Page, settings: Record<string, unknown> = {}) => {
  await page.addInitScript(
    ([key, more]) => {
      sessionStorage.setItem(key, JSON.stringify(more));
      const notes: unknown[] = [];
      const withdrawn: string[] = [];
      let onAction: ((action: unknown) => void) | undefined;
      // Away: the window never has focus here, whatever the host's own state.
      Document.prototype.hasFocus = () => false;
      (window as unknown as { away: unknown }).away = {
        notes,
        withdrawn,
        sent: [],
        act: (action: unknown) => onAction?.(action),
      };
      Object.defineProperty(window, "gram", {
        configurable: true,
        value: {
          platform: "darwin",
          onMenu: () => () => {},
          onNotificationClick: () => () => {},
          onNotificationAction: (callback: (action: unknown) => void) => {
            onAction = callback;
            return () => {
              onAction = undefined;
            };
          },
          withdrawNotification: (id: string) => withdrawn.push(id),
          notify: (notification: unknown) => notes.push(notification),
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
    },
    [MOCK_SETTINGS_KEY, settings] as const,
  );
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  // Asks open as the window loads are the stack's; these arrive once it has settled.
  await page.waitForTimeout(AFTER_GRACE_MS);
  return page.evaluate(() => {
    const mock = window.gramMock!;
    const sent = (window as unknown as { away: Recorded }).away.sent;
    const respondMany = mock.respondMany.bind(mock);
    mock.respondMany = (answers) => {
      sent.push(...answers.map((a) => ({ requestId: a.requestId, answer: a.answer })));
      return respondMany(answers);
    };
    return mock.simulateAsks();
  });
};

/** The latest notification with `body`, and with `title` when given. */
const noteWith = async (page: Page, body: string, title?: string) => {
  const match = (n: DesktopNotification) =>
    n.body === body && (title === undefined || n.title === title);
  await expect.poll(async () => (await recorded(page)).notes.some(match)).toBe(true);
  return (await recorded(page)).notes.findLast(match)!;
};

test("Allow on a notification answers the ask through the stack, and it is gone everywhere", async ({
  page,
}) => {
  const made = await start(page, { helpers: { enabled: false } });
  // The seed's push grows to three workers: its first, smaller notification is taken back.
  const note = await noteWith(page, PUSH, "Allow git push × 3?");
  const earlier = (await recorded(page)).notes.filter((n) => n.body === PUSH && n.id !== note.id);
  for (const n of earlier) expect((await recorded(page)).withdrawn).toContain(n.id);
  expect(note).toMatchObject({
    title: "Allow git push × 3?",
    subtitle: expect.stringContaining("agent-platform"),
    actions: ["Allow 3"],
  });
  // Only asks interrupt: nothing else the seed did raised one.
  const before = await recorded(page);
  expect(before.notes.every((n) => n.id?.startsWith("ask-"))).toBe(true);
  const sentBefore = before.sent.length;

  await act(page, { id: note.id!, action: 0 });
  // A pressed button closes its notification in the shell; the page sends no withdraw for it.

  await openOrchestrator(page, made.orchestratorThreadId);
  const stack = page.getByTestId("ask-stack");
  await expect(stack).toBeVisible();
  // The stack's own undo line: the same held answer, not a second path.
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await expect(stack.getByTestId("ask-command").filter({ hasText: PUSH })).toHaveCount(0);

  await page.waitForTimeout(SENT_MS);
  const after = await recorded(page);
  const answers = after.sent.slice(sentBefore) as {
    requestId: RequestId;
    answer: unknown;
  }[];
  expect(answers).toHaveLength(3);
  for (const { answer } of answers)
    expect(answer).toEqual({ kind: "approval", decision: "allow", scope: "once" });
  await expect(stack.getByTestId("ask-command").filter({ hasText: PUSH })).toHaveCount(0);

  // A second press of the same notification finds nothing to answer and sends nothing.
  await act(page, { id: note.id!, action: 0 });
  await page.waitForTimeout(SENT_MS);
  expect((await recorded(page)).sent).toHaveLength(after.sent.length);
});

test("a command the banner would cut offers Open only, which shows it whole in the stack", async ({
  page,
}) => {
  const made = await start(page, { helpers: { enabled: false } });
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
  const note = await noteWith(page, `${LONG.slice(0, 37)}…\nCut short. Open to review.`);
  expect(note.actions).toBeUndefined();
  expect(note.title).toBe("Allow git push?");

  await act(page, { id: note.id!, action: "open" });
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const current = page
    .getByTestId("ask-stack")
    .locator('li:not([inert]) [data-testid="ask-item"][data-current]');
  await expect(current.getByTestId("ask-command")).toHaveText(LONG);
});

/** A short command that fits a banner whole. */
const build = (id: string) => ({
  kind: "approval" as const,
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command: `npm run build:${id}` },
  suggestions: [],
  scopes: ["once" as const],
});

test("titles come from the template with helpers off, and from the helper with them on", async ({
  page,
}) => {
  const made = await start(page);
  await page.evaluate(
    ([threadId, request]) => {
      window.gramMock!.armNoticeTitle(request.id, "A worker wants a build");
      window.gramMock!.simulateRequest(threadId, request);
    },
    [made.freeForm.threadId, build("r-on")] as const,
  );
  const on = await noteWith(page, "npm run build:r-on");
  expect(on.title).toBe("A worker wants a build");
  expect(on.actions).toEqual(["Allow"]);

  await page.evaluate(() => window.gramMock!.updateSettings({ helpers: { enabled: false } }));
  await page.evaluate(
    ([threadId, request]) => {
      window.gramMock!.armNoticeTitle(request.id, "A worker wants a build");
      window.gramMock!.simulateRequest(threadId, request);
    },
    [made.choosing, build("r-off")] as const,
  );
  const off = await noteWith(page, "npm run build:r-off");
  expect(off.title).toBe("Allow npm run?");
});
