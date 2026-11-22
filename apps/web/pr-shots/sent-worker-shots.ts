import { expect, type Page } from "@playwright/test";

import { seedDesktopShell } from "../e2e/desktop-shell-fixture";
import { motionDone } from "../e2e/settled";
import { threadRow } from "../e2e/thread-row";
import { openBoardSidebar, openBoardView } from "./board";
import type { Shot } from "./shots";

// A worker sent to a server (`send_worker`): the workspace setting that lets the orchestrator ask,
// the one-time card that asks, as the server words it, and the worker once it runs there.

const ORIGIN = "https://gram.example.com";

/** A desktop shell signed in to one server, "Example", with one workspace there, "Platform". */
const seedSignedIn = async (page: Page) => {
  await seedDesktopShell(page, {});
  await page.addInitScript((origin) => {
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ experimental: { embedding: true } }),
    );
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
        work: {
          send: async () => ({ ok: false, why: "Not in a shot." }),
        },
      },
    });
  }, ORIGIN);
};

/** The brief as the orchestrator wrote it, and the card the server raises for it. */
const BRIEF =
  "Make the refund webhook idempotent: a retried delivery with the same event id must not refund twice. Add a test that replays one delivery three times, then open a pull request against main.";

const raiseSendWorker = (page: Page, threadId: string) =>
  page.evaluate(
    ([id, brief]) =>
      window.gramMock!.simulateRequest(id as never, {
        kind: "approval",
        id: "r-send-worker" as never,
        toolUseId: "send-worker-1",
        toolName: "mcp__gram__send_worker",
        displayName: "send_worker",
        title: "Send worker to Example?",
        description:
          "Send “Idempotent refund webhooks” from api to run in Platform · gram.example.com, as a thread of that workspace. Example Co's rules and approvals apply there, and it runs on Claude · opus, not Claude · sonnet that workers here run on.",
        input: {
          workspace: "Platform · gram.example.com",
          organisation: "Example Co",
          model: "Claude · opus",
          workerModel: "Claude · sonnet",
          project: "api",
          repository: "example-co/billing-api",
          title: "Idempotent refund webhooks",
          reason:
            "You asked for the refund fix to run on the team's server so it keeps going overnight.",
          brief,
        },
        suggestions: [],
        scopes: ["once"],
      }),
    [threadId, BRIEF] as const,
  );

/** The board workspace with its orchestrator open, asking to send a worker to "Platform". */
const openAsking = async (page: Page) => {
  await seedSignedIn(page);
  const made = await openBoardSidebar(page);
  await raiseSendWorker(page, made.orchestratorThreadId);
  await page.getByTestId("approval-card").filter({ hasText: "Send worker" }).waitFor();
  return made;
};

/** The board workspace with its `working` worker sent to Platform, at work there. */
const openSent = async (page: Page) => {
  await seedSignedIn(page);
  const made = await openBoardSidebar(page);
  await page.evaluate(
    ([id, origin]) =>
      window.gramMock!.sendToServer(id as never, {
        origin,
        server: "Example",
        workspaceId: "w1",
        workspace: "Platform",
        threadId: "th-remote-1",
        branch: "gram/idempotent-refund-webhooks",
        at: Date.now() - 4 * 60_000,
        state: "running",
        working: true,
        reply: "Reading the webhook handler and the refunds table's unique keys.",
        heardAt: Date.now() - 30_000,
      }),
    [made.working, ORIGIN] as const,
  );
  await threadRow(page, made.working).getByTestId("overview-worker-machine").waitFor();
  return made;
};

export const SENT_WORKER_SHOTS: readonly Shot[] = [
  {
    name: "sent-worker-setting",
    title:
      "A workspace's settings in the desktop app, signed in to a server: Send workers to servers, on",
    open: async (page) => {
      await seedSignedIn(page);
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto("/settings/workspaces");
      await page.getByTestId("workspace-settings").waitFor();
      await page.evaluate(async () => {
        const api = window.gramMock!;
        const made = await api.simulateOrchestration("board");
        const state = (await api.listWorkspaces()).find(
          (each) => each.workspace.id === made.workspaceId,
        )!;
        await api.setOrchestratorCharter(made.workspaceId, {
          ...state.charter,
          sendWork: true,
        });
      });
      await page
        .getByRole("listitem", { name: "Workspace agent-platform" })
        .getByTestId("workspace-link")
        .click();
      const field = page.getByTestId("send-work");
      await expect(field).toHaveAttribute("data-value", "on");
      await field.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await motionDone(page);
    },
  },
  {
    name: "sent-worker-approval-thread",
    title: "The orchestrator asks to send a worker to a server: its card in the thread",
    open: async (page) => {
      await openAsking(page);
      await page.mouse.move(0, 0);
      await motionDone(page);
    },
  },
  {
    name: "sent-worker-approval-inbox",
    title: "The same card in the Inbox",
    open: async (page) => {
      await openAsking(page);
      await page.keyboard.press("ControlOrMeta+Shift+I");
      await page.getByTestId("inbox").waitFor();
      await page
        .getByTestId("inbox-item")
        .filter({ hasText: "Idempotent refund webhooks" })
        .first()
        .click();
      await page
        .getByRole("region", { name: "Approval", exact: true })
        .getByRole("button", { name: /^Allow once/ })
        .waitFor();
      await page.mouse.move(0, 0);
      await motionDone(page);
    },
  },
  {
    name: "sent-worker-sidebar",
    title: "The sent worker, at work on the server, in the sidebar and on the Board",
    open: async (page) => {
      await openSent(page);
      await openBoardView(page);
      await page.mouse.move(0, 0);
      await motionDone(page);
    },
  },
  {
    name: "sent-worker-thread",
    title: "The sent worker's thread: where it runs, its last words there, and no composer",
    open: async (page) => {
      const made = await openSent(page);
      await threadRow(page, made.working).click();
      await page.waitForURL(new RegExp(`/t/${made.working}$`));
      await page.getByTestId("sent-notice").waitFor();
      await page.mouse.move(0, 0);
      await motionDone(page);
    },
  },
];
