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
