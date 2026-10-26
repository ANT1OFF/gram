import { expect, test, type Page } from "@playwright/test";

// Settings → General's Open at launch and Notify me about rows, each followed to what it changes.

const general = (page: Page) => page.getByTestId("general-settings");

const choice = (page: Page, group: string, name: string) =>
  general(page).getByRole("radiogroup", { name: group }).getByRole("radio", { name });

test("Open at launch at Last thread opens the thread shown last", async ({ page }) => {
  // Four launches of the app in one test.
  test.slow();
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();

  // At Last orchestrator, with no workspace open, a launch stays home.
  await page.goto("/");
  // The home page shows its own content only once the launch has decided to stay.
  await expect(
    page
      .getByRole("region", { name: "Pick a repository to start" })
      .or(page.getByText("Select a thread, or start a new one.")),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/settings/general");
  await expect(choice(page, "Open at launch", "Last orchestrator")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await choice(page, "Open at launch", "Last thread").click();
  await expect(choice(page, "Open at launch", "Last thread")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await page.goto("/");
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
});

test("Notify me about at Asks only keeps failures out of desktop notifications", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const notes: unknown[] = [];
    // Away: the window never has focus here, whatever the host's own state.
    Document.prototype.hasFocus = () => false;
    (window as unknown as { notes: unknown[] }).notes = notes;
    Object.defineProperty(window, "gram", {
      configurable: true,
      value: {
        platform: "darwin",
        onMenu: () => () => {},
        onNotificationClick: () => () => {},
        onNotificationAction: () => () => {},
        withdrawNotification() {},
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
  });
  await page.goto("/settings/general");
  await expect(choice(page, "Notify me about", "Asks and failures")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const titles = () =>
    page.evaluate(() =>
      (window as unknown as { notes: { title: string }[] }).notes.map((note) => note.title),
    );
  const fail = (title: string) =>
    page.evaluate(
      (t) => window.gramMock!.simulateNotification({ type: "notify", kind: "error", title: t }),
      title,
    );

  await fail("First failure");
  await expect.poll(titles).toContain("First failure");

  await choice(page, "Notify me about", "Asks only").click();
  await expect(choice(page, "Notify me about", "Asks only")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await fail("Second failure");
  await page.evaluate(() =>
    window.gramMock!.simulateNotification({
      type: "notify",
      kind: "needsInput",
      title: "Approval needed",
    }),
  );
  await expect.poll(titles).toContain("Approval needed");
  expect(await titles()).not.toContain("Second failure");
});
