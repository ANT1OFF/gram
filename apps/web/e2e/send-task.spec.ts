import { expect, test, type Page } from "@playwright/test";

import { seedDesktopShell } from "./desktop-shell-fixture";

// New task sends a task to a hosted workspace: only inside the desktop app, with the hosted
// features on and a server signed in to that runs sent work. The shell is a fake, and the local
// server's two routes are answered here; nothing leaves the page.

const ORIGIN = "https://gram.example.com";

const seedSignedIn = async (page: Page) => {
  await seedDesktopShell(page, {});
  await page.addInitScript((origin) => {
    Object.assign((window as unknown as { gram: object }).gram, {
      hostedDevice: {
        state: async () => ({
          servers: [
            {
              origin,
              name: "Example",
              signedIn: true,
              paused: false,
              runsWork: true,
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
        signIn: async () => ({ ok: true }),
        signOut: async () => {},
        refresh: async () => ({ ok: true }),
        lend: async () => ({ ok: true }),
        resume: async () => ({ ok: true }),
        stop: async () => {},
        liftPause: async () => ({ ok: true }),
        startAfresh: async () => ({ ok: true }),
        activity: async () => null,
        onChange: () => () => {},
      },
    });
  }, ORIGIN);
};

const checked = (over: { reach?: string; ahead?: number }) => ({
  targets: [],
  repository: "example-co/billing-api",
  orchestrator: true,
  local: {
    current: "main",
    base: { branch: "main", sha: "4be1c09" },
    ahead: over.ahead ?? 0,
    uncommitted: { count: 3, first: "src/refunds.ts" },
  },
  reach: {
    repository: "example-co/billing-api",
    reach: over.reach ?? "yes",
    ...(over.reach === "no" ? { reason: "The Runheim GitHub App doesn't reach it." } : {}),
  },
});

test("a task goes to a hosted workspace only once its checks pass", async ({ page }) => {
  await seedSignedIn(page);
  let answer = checked({ reach: "no", ahead: 2 });
  const sent: unknown[] = [];
  await page.route("**/threads/send-check", (route) => route.fulfill({ json: answer }));
  await page.route("**/threads/send", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Example didn't start it: stop here." } });
  });
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const made = await page.evaluate(async () => {
    const mock = window.gramMock!;
    await mock.simulateSettingsChange({ experimental: { embedding: true } });
    return mock.simulateOrchestration();
  });
  await page.evaluate((id) => {
    history.pushState({}, "", `/new-task?workspace=${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, made.workspaceId);
  await page.getByLabel("What needs doing").fill("Make refund webhooks idempotent.");

  // This computer until a hosted workspace is picked.
  const machine = page.getByTestId("send-target");
  await expect(machine).toContainText(/This (Mac|computer)/);
  await machine.click();
  await page.getByRole("option", { name: "Platform" }).click();

  // Blocked: the server can't reach it, and main has commits only here.
  const checks = page.getByTestId("send-checks");
  await expect(checks.getByTestId("send-check-reach")).toHaveAttribute("data-state", "block");
  await expect(checks.getByTestId("send-check-base")).toHaveAttribute("data-state", "block");
  await expect(checks.getByTestId("send-check-uncommitted")).toHaveAttribute("data-state", "warn");
  const submit = page.getByTestId("task-submit");
  await expect(submit).toContainText("Send to Platform");
  await expect(submit).toBeDisabled();

  // Fixed there and pushed here: Check again lets it go, uncommitted files only warn.
  answer = checked({});
  await page.getByRole("button", { name: "Check again" }).first().click();
  await expect(checks.getByTestId("send-check-reach")).toHaveAttribute("data-state", "ok");
  await expect(submit).toBeEnabled();
  await submit.click();
  // The server's refusal is said, and the draft stays.
  await expect(page.getByRole("alert").filter({ hasText: "stop here" })).toBeVisible();
  expect(sent).toEqual([
    {
      workspaceId: made.workspaceId,
      projectId: expect.any(String),
      target: { origin: ORIGIN, workspaceId: "w1" },
      text: "Make refund webhooks idempotent.",
      clientRequestId: expect.any(String),
    },
  ]);
});

const SHOTS = process.env["GRAM_SEND_SHOTS"];

const openSend = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const made = await page.evaluate(async () => {
    const mock = window.gramMock!;
    await mock.simulateSettingsChange({ experimental: { embedding: true } });
    return mock.simulateOrchestration();
  });
  await page.evaluate((id) => {
    history.pushState({}, "", `/new-task?workspace=${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, made.workspaceId);
  await page.getByLabel("What needs doing").fill("Make refund webhooks idempotent.");
  await page.getByTestId("send-target").click();
  await page.getByRole("option", { name: "Platform" }).click();
};

test("a send with no machine running there starts the person's machine, then sends", async ({
  page,
}) => {
  await seedSignedIn(page);
  // The server couldn't be asked about the repository: nothing is said of it.
  const { reach: _reach, ...unasked } = checked({});
  await page.route("**/threads/send-check", (route) =>
    route.fulfill({ json: { ...unasked, machine: { phase: "none", starting: false } } }),
  );
  const steps = [
    { state: "starting", phase: "none" },
    { state: "starting", phase: "pending" },
    { state: "starting", phase: "starting" },
    { state: "ready", phase: "running" },
  ];
  const machineAsked: unknown[] = [];
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  await page.route("**/threads/send-machine", async (route) => {
    machineAsked.push(route.request().postDataJSON());
    // Ready only once the test has seen it boot.
    if (machineAsked.length === 4) await held;
    return route.fulfill({ json: steps[Math.min(machineAsked.length - 1, steps.length - 1)] });
  });
  // The first send lands before the new machine has joined there; the same send goes again.
  let sends = 0;
  await page.route("**/threads/send", (route) => {
    sends += 1;
    return sends === 1
      ? route.fulfill({
          status: 409,
          json: {
            error:
              "Example didn't start it: You have no machine running, and this Gram runs no work itself. Start a machine to run this.",
          },
        })
      : route.fulfill({ json: { threadId: "t-sent" } });
  });
  await openSend(page);

  const checks = page.getByTestId("send-checks");
  await expect(checks.getByTestId("send-check-machine")).toHaveAttribute("data-state", "ok");
  await expect(checks.getByTestId("send-check-reach")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/after-1-checks.png`, fullPage: true });

  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("send-machine")).toContainText(
    "Starting your machine on gram.example.com — waiting for room…",
  );
  await expect(page.getByTestId("send-machine")).toContainText("booting", { timeout: 10_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/after-2-starting.png`, fullPage: true });
  release();
  await expect(page).toHaveURL(/\/t\/t-sent/, { timeout: 20_000 });
  expect(machineAsked[0]).toEqual({ target: { origin: ORIGIN, workspaceId: "w1" } });
  expect(sends).toBe(2);
});
