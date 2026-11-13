import { expect, test, type Page } from "@playwright/test";

import { seedDesktopShell } from "./desktop-shell-fixture";

// A workspace moves to a server signed in to, from its line's menu: only inside the desktop app,
// with the hosted features on. The shell here is a fake that answers as a server would; nothing
// leaves the page.

const ORIGIN = "https://gram.example.com";

/** A desktop shell signed in to one server, whose move goes through in three told steps. */
const seedSignedIn = async (page: Page) => {
  await seedDesktopShell(page, {});
  await page.addInitScript((origin) => {
    let progress: ((progress: unknown) => void) | undefined;
    let finish: ((done: unknown) => void) | undefined;
    const calls: string[] = [];
    const answer = { ok: async () => ({ ok: true }) };
    Object.assign((window as unknown as { gram: object }).gram, {
      hostedDevice: {
        state: async () => ({
          servers: [
            {
              origin,
              name: "Example",
              signedIn: true,
              paused: false,
              workspaces: [
                {
                  id: "w1",
                  name: "Platform",
                  organisation: "Example Co",
                  policy: "on",
                  lending: "off",
                  readOnly: false,
                  folders: [],
                  connected: false,
                },
              ],
            },
          ],
        }),
        signIn: answer.ok,
        signOut: async () => {},
        refresh: answer.ok,
        lend: answer.ok,
        resume: answer.ok,
        stop: async () => {},
        liftPause: answer.ok,
        startAfresh: answer.ok,
        activity: async () => null,
        onChange: () => () => {},
        move: {
          check: async () => ({
            ok: true,
            repositories: [
              { name: "example-co/api", reached: true },
              { name: "example-co/fixtures", reached: false },
            ],
            autonomyCeiling: "supervised",
          }),
          start: (...args: string[]) => {
            calls.push(`start ${args.join(" ")}`);
            return new Promise((resolve) => (finish = resolve));
          },
          cancel: async () => {
            calls.push("cancel");
            finish?.({ ok: false, cancelled: true, why: "Cancelled." });
          },
          onProgress: (callback: (progress: unknown) => void) => {
            progress = callback;
            return () => (progress = undefined);
          },
        },
      },
    });
    Object.assign(window, {
      moveFake: {
        calls,
        tell: (next: unknown) => progress?.(next),
        finish: (done: unknown) => finish?.(done),
      },
    });
  }, ORIGIN);
};

interface MoveFake {
  readonly calls: string[];
  tell(progress: unknown): void;
  finish(done: unknown): void;
}
const fake = (page: Page, run: (fake: MoveFake, origin: string) => unknown) =>
  page.evaluate(
    ([body, origin]) =>
      // oxlint-disable-next-line no-new-func, typescript/no-implied-eval -- the test's own closure, run in the page.
      new Function("fake", "origin", `return (${body})(fake, origin)`)(
        (window as unknown as { moveFake: MoveFake }).moveFake,
        origin,
      ),
    [run.toString(), ORIGIN] as const,
  );

const setUp = async (page: Page, hosted: boolean) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  return page.evaluate(async (on) => {
    const mock = window.gramMock!;
    await mock.simulateSettingsChange({ experimental: { embedding: on } });
    return mock.simulateOrchestration();
  }, hosted);
};

const openMenu = async (page: Page, workspaceId: string) => {
  const row = page
    .locator(`[data-testid="overview-workspace"][data-workspace-id="${workspaceId}"]`)
    .getByTestId("overview-workspace-row");
  await row.click({ button: "right" });
  await expect(page.getByTestId("menu-workspace-settings")).toBeVisible();
};

test("a workspace moves to a server signed in to, and stays here paused", async ({ page }) => {
  await seedSignedIn(page);
  const made = await setUp(page, true);
  await openMenu(page, made.workspaceId);
  await page.getByTestId("menu-workspace-move").click();

  // What goes, what stays, and what the server says of its repositories and its autonomy.
  const sheet = page.getByTestId("move-workspace-dialog");
  await expect(sheet.getByRole("heading")).toContainText("to a server");
  await expect(sheet.getByTestId("move-workspace-to")).toContainText("Platform · gram.example.com");
  await expect(sheet.getByTestId("move-workspace-goes")).toContainText("Memory");
  await expect(sheet.getByTestId("move-workspace-stays")).toContainText("Sign-ins and keys");
  await expect(sheet.getByTestId("move-workspace-repositories")).toContainText(
    "Not in Example Co's GitHub access there. The workspace moves without it.",
  );
  await expect(sheet).toContainText("Kept here afterwards, never deleted.");
  await sheet.getByTestId("move-workspace-start").click();

  // Under way: each step as the shell tells it, and a way out until the server has it all.
  const steps = sheet.getByTestId("move-workspace-steps");
  await expect(steps.locator('[data-step="stopping"]')).toHaveAttribute("data-state", "now");
  await fake(page, (f) =>
    f.tell({ stage: "sending", sentBytes: 31 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 }),
  );
  await expect(steps.locator('[data-step="sending"]')).toHaveAttribute("data-state", "now");
  await expect(sheet).toContainText("31 MB of 50 MB");
  await page.keyboard.press("Escape");
  await expect(steps).toBeVisible();
  await fake(page, (f) => f.tell({ stage: "settingUp" }));
  await expect(sheet.getByTestId("move-workspace-cancel")).toBeDisabled();
  await fake(page, (f, origin) =>
    f.finish({
      ok: true,
      movedAt: Date.now(),
      url: `${origin}/w/w1/threads`,
      left: ["example-co/fixtures"],
    }),
  );

  // Where it runs now, what did not come, and that nothing here was deleted.
  await expect(sheet.getByRole("heading")).toContainText("now runs in Platform");
  await expect(sheet).toContainText("was told what didn't come: example-co/fixtures");
  await expect(sheet.getByTestId("move-workspace-after")).toContainText("Nothing was deleted.");
  await expect(sheet.getByTestId("move-workspace-open")).toBeVisible();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
  // The workspace is still listed here.
  await expect(
    page.locator(`[data-testid="overview-workspace"][data-workspace-id="${made.workspaceId}"]`),
  ).toBeVisible();
});

test("a cancelled move comes back to the review with nothing moved", async ({ page }) => {
  await seedSignedIn(page);
  const made = await setUp(page, true);
  await openMenu(page, made.workspaceId);
  await page.getByTestId("menu-workspace-move").click();
  const sheet = page.getByTestId("move-workspace-dialog");
  await sheet.getByTestId("move-workspace-start").click();
  await sheet.getByTestId("move-workspace-cancel").click();
  await expect(sheet.getByTestId("move-workspace-start")).toBeVisible();
  await expect(sheet.getByTestId("move-workspace-error")).toHaveCount(0);
  expect(await fake(page, (f) => f.calls)).toContain("cancel");
});

test("the menu has no move without the hosted features, or outside the desktop app", async ({
  page,
}) => {
  // In a browser, with the hosted features on: no shell to move one.
  const browser = await setUp(page, true);
  await openMenu(page, browser.workspaceId);
  await expect(page.getByTestId("menu-workspace-move")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // In the desktop app signed in to a server, with the hosted features off.
  const desktop = await page.context().newPage();
  await seedSignedIn(desktop);
  const made = await setUp(desktop, false);
  await openMenu(desktop, made.workspaceId);
  await expect(desktop.getByTestId("menu-workspace-move")).toHaveCount(0);
});
