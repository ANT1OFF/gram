import { expect, type Page } from "@playwright/test";

import { seedDesktopShell } from "../e2e/desktop-shell-fixture";
import { motionDone } from "../e2e/settled";
import type { Shot } from "./shots";

// A solo thread moving to a workspace of a server signed in to: thread menu → Move to a server….
// The desktop shell is a fake signed in to two servers, one with two workspaces, so the review
// has a choice to make; nothing leaves the page.

const workspace = (id: string, name: string, organisation: string) => ({
  id,
  name,
  organisation,
  policy: "on",
  lending: "off",
  readOnly: false,
  folders: [],
  connected: false,
});

const SERVERS = [
  {
    origin: "https://gram.example.com",
    name: "Example",
    signedIn: true,
    paused: false,
    takesThreads: true,
    givesThreads: true,
    workspaces: [
      workspace("w1", "Platform", "Example Co"),
      workspace("w2", "Payments", "Example Co"),
    ],
  },
  {
    origin: "https://gram.northwind.dev",
    name: "Northwind",
    signedIn: true,
    paused: false,
    takesThreads: true,
    givesThreads: true,
    workspaces: [workspace("w9", "Research", "Northwind Labs")],
  },
];

/** The shell signed in to two servers that take threads, with three workspaces between them. */
const seedTwoServers = async (page: Page) => {
  await seedDesktopShell(page, {});
  await page.addInitScript(() => {
    const key = "gram.mock.settings";
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, object>;
    saved["experimental"] = { ...saved["experimental"], embedding: true };
    sessionStorage.setItem(key, JSON.stringify(saved));
  });
  await page.addInitScript((servers) => {
    const answer = { ok: async () => ({ ok: true }) };
    Object.assign((window as unknown as { gram: object }).gram, {
      hostedDevice: {
        state: async () => ({ servers }),
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
        moveThread: () => new Promise(() => {}),
      },
    });
  }, SERVERS);
};

/** t-flaky, its turn allowed through to its end, with the move's review open from its menu. */
const openMoveReview = async (page: Page) => {
  await seedTwoServers(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("approval-allow").click();
  await page.getByText("Done. Summary:").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Thread", exact: true }).click();
  await page.getByTestId("menu-move-thread").click();
  const sheet = page.getByTestId("move-thread-dialog");
  await sheet.waitFor();
  await expect(sheet).not.toContainText("Reading its edits");
  await motionDone(sheet);
  return sheet;
};

export const MOVE_THREAD_SHOTS: readonly Shot[] = [
  {
    name: "move-thread-review",
    title: "Move to a server…, as it opens: three workspaces on two servers to choose from",
    open: async (page) => {
      await openMoveReview(page);
    },
    element: (page) => page.getByTestId("move-thread-dialog"),
  },
  {
    name: "move-thread-review-picked",
    title: "Move to a server… with Payments on gram.example.com chosen, ready to move",
    open: async (page) => {
      const sheet = await openMoveReview(page);
      const to = sheet.getByTestId("move-thread-to");
      if ((await to.evaluate((el) => el.tagName)) === "SELECT") {
        await to.selectOption({ label: "Payments · gram.example.com · Example Co" });
      } else {
        await sheet.getByRole("radio", { name: /Payments/ }).check();
      }
      await motionDone(sheet);
    },
    element: (page) => page.getByTestId("move-thread-dialog"),
  },
];
