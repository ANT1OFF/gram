import { expect, type Page } from "@playwright/test";

import { openPanelTab } from "../e2e/panel-tab";
import { threadRow } from "../e2e/thread-row";
import { openBoardSidebar, openBoardView } from "./board";
import type { Shot } from "./shots";

/** A synthetic hosted server's mark, as `MachineState.hosted.logo` carries it: a `data:` SVG. */
const HOSTED_LOGO = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#2f7d6d"/><path d="M4 11.5 8 4l4 7.5z" fill="#fff"/></svg>',
).toString("base64")}`;

/**
 * The board workspace with three synthetic machines as the server sends them (atlas online, studio
 * offline, sandbox-1 a provisioned host), a worker placed on each and a solo thread on atlas; the
 * rest run on this machine and carry no marker. With `hosted`, sandbox-1 came through a signed-in
 * hosted server that gave its logo, and a fourth provisioned host from one that gave none carries
 * a waiting worker.
 */
const openMachineMarkers = async (page: Page, { hosted = false } = {}) => {
  const made = await openBoardSidebar(page);
  await page.evaluate(
    ([ids, viaServer, logo]) => {
      const mock = window.gramMock!;
      const atlas = "m-0123456789abcdef01234567";
      const studio = "m-89abcdef0123456701234567";
      const sandbox = "m-456789abcdef012301234567";
      const lettered = "m-cdef0123456789ab01234567";
      const now = Date.now();
      mock.setMachines([
        {
          id: atlas,
          name: "atlas",
          kind: "joined",
          onlineSince: now - 2 * 3_600_000,
        },
        {
          id: studio,
          name: "studio",
          kind: "joined",
          offline: { kind: "lost", at: now - 420_000 },
        },
        {
          id: sandbox,
          name: "sandbox-1",
          kind: "provisioned",
          onlineSince: now - 720_000,
          ...(viaServer ? { hosted: { name: "Example Cloud", logo } } : {}),
        },
        ...(viaServer
          ? [
              {
                id: lettered,
                name: "worker-5c1e9a2b70",
                kind: "provisioned",
                onlineSince: now - 300_000,
                hosted: { name: "Northwind" },
              },
            ]
          : []),
      ] as never);
      mock.placeOnMachine(ids.working, atlas);
      mock.placeOnMachine(ids.waiting[0], viaServer ? lettered : atlas);
      mock.placeOnMachine(ids.inReview, studio);
      mock.placeOnMachine(ids.ungrouped, sandbox);
      mock.placeOnMachine("t-flaky" as never, atlas);
    },
    [made, hosted, HOSTED_LOGO] as const,
  );
  await threadRow(page, made.working).getByTestId("overview-worker-machine").waitFor();
  return made;
};

/**
 * The board workspace with a worker on a machine in each state whoever runs it can be in: online,
 * reclaimed by its provider and restarting, paused while idle, its threads being put back, and
 * failed with the provider's reason. Two came through a hosted server, which gave its logo.
 */
const openMachineStates = async (page: Page) => {
  const made = await openBoardSidebar(page);
  await page.evaluate(
    ([ids, logo]) => {
      const mock = window.gramMock!;
      const now = Date.now();
      const hosted = { name: "Example Cloud", logo };
      mock.setMachines([
        {
          id: "m-0123456789abcdef01234567",
          name: "atlas",
          kind: "joined",
          onlineSince: now - 7_200_000,
        },
        {
          id: "m-89abcdef0123456701234567",
          name: "worker-827d7eaf1e",
          kind: "provisioned",
          hosted,
          offline: { kind: "lost", at: now - 240_000 },
          starting: now - 200_000,
          provider: {
            phase: "starting",
            cause: "reclaimed",
            since: now - 240_000,
            at: now - 220_000,
          },
        },
        {
          id: "m-456789abcdef012301234567",
          name: "worker-5c1e9a2b70",
          kind: "provisioned",
          hosted,
          offline: { kind: "lost", at: now - 3_000_000 },
          paused: now - 3_000_000,
        },
        {
          id: "m-cdef0123456789ab01234567",
          name: "sandbox-1",
          kind: "provisioned",
          onlineSince: now - 90_000,
          restoring: now - 90_000,
        },
        {
          id: "m-fedcba987654321001234567",
          name: "sandbox-2",
          kind: "provisioned",
          offline: { kind: "lost", at: now - 600_000 },
          provider: {
            phase: "failed",
            message: "No capacity for this size in the zone.",
            since: now - 540_000,
            at: now - 500_000,
          },
        },
      ] as never);
      mock.placeOnMachine(ids.working, "m-0123456789abcdef01234567");
      mock.placeOnMachine(ids.waiting[0], "m-89abcdef0123456701234567");
      mock.placeOnMachine(ids.inReview, "m-456789abcdef012301234567");
      mock.placeOnMachine(ids.ungrouped, "m-cdef0123456789ab01234567");
      mock.placeOnMachine("t-flaky" as never, "m-fedcba987654321001234567");
    },
    [made, HOSTED_LOGO] as const,
  );
  await threadRow(page, made.working).getByTestId("overview-worker-machine").waitFor();
  return made;
};

/**
 * A worker whose machine is being replaced mid-turn (a cloud machine reclaimed). After: a quiet
 * line says it is moving and resumes on its own, and its sidebar row says Moving. Before: on a
 * build without the move, the turn failed with the agent's exit, as the server ended it then.
 */
const MACHINE_MOVING: Shot = {
  name: "machine-moving",
  title: "A worker whose machine is being replaced mid-turn: the thread and its sidebar row",
  open: async (page) => {
    await page.goto("/t/t-docs");
    await page.getByLabel("Message", { exact: true }).waitFor();
    await page.evaluate(() => window.gramMock!.turnEnded?.("t-docs" as never));
    const moved = await page.evaluate(() => {
      const mock = window.gramMock! as unknown as Record<string, unknown>;
      const move = mock["simulateMachineMove"] as
        | ((threadId: string, machine: string, until?: number) => void)
        | undefined;
      if (move === undefined) return false;
      // The turn the move cut off is still open: the thread waits to carry it on.
      window.gramMock!.simulateStatus("t-docs" as never, "running");
      move.call(mock, "t-docs", "build-box", Date.now() + 20 * 60_000);
      return true;
    });
    if (!moved)
      await page.evaluate(() =>
        window.gramMock!.simulateTurnError(
          "t-docs" as never,
          {
            kind: "unknown",
            retryable: false,
            text: "The turn failed: agent session ended: error: Claude Code process exited with code 143",
          },
          "Tidy the guide",
        ),
      );
    const shown = page.getByTestId("machine-move").or(page.getByTestId("agent-error"));
    await shown.first().waitFor();
    await shown.first().scrollIntoViewIfNeeded();
    await expect(shown.first()).toBeInViewport();
  },
};

export const MACHINE_MARKER_SHOTS: readonly Shot[] = [
  MACHINE_MOVING,
  {
    name: "machine-marker-states",
    title:
      "The sidebar with workers on machines in each state: online, reclaimed and restarting (hosted logo, pulsing badge), paused while idle (hollow ring), restoring, and failed (red badge); the reclaimed one's hover names its state, since when and why",
    open: async (page) => {
      const made = await openMachineStates(page);
      await threadRow(page, made.waiting[0]).hover();
      await expect(page.getByTestId("overview-worker-card-machine")).toContainText("reclaimed");
    },
  },
  {
    name: "machine-marker-sidebar",
    title:
      "The sidebar with workers on other machines: the machine's glyph and name at a row's edge, the glyph alone beside the row's own words, offline said in words, nothing for a thread on this machine",
    open: async (page) => {
      const made = await openMachineMarkers(page);
      await threadRow(page, made.working).hover();
      await page.getByTestId("overview-worker-card-machine").waitFor();
      await page.waitForTimeout(500);
    },
  },
  {
    name: "machine-marker-board",
    title:
      "The Board and the Workers tab: each worker on another machine names it under its task and after its status, an offline one with the struck glyph",
    open: async (page) => {
      await openMachineMarkers(page);
      await openPanelTab(page.getByTestId("right-panel"), "Workers");
      await page.getByTestId("overview-worker-machine").first().waitFor();
      await openBoardView(page);
      await page.getByTestId("rail-machine").first().waitFor();
      await page.mouse.move(700, 980);
      await page.waitForTimeout(500);
    },
  },
  {
    name: "machine-marker-hosted",
    title:
      "The Board with workers on hosted servers' machines: the server's logo, or its name's first letter, in place of the machine id; the hover names the server and keeps the id",
    open: async (page) => {
      await openMachineMarkers(page, { hosted: true });
      await openBoardView(page);
      await page.getByTestId("rail-machine").first().waitFor();
      await page
        .getByTestId("rail-machine")
        .and(page.getByRole("img", { name: /^Runs on (sandbox-1|Example Cloud's machine)$/ }))
        .first()
        .hover();
      await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveCSS(
        "opacity",
        "1",
      );
    },
  },
  {
    name: "machine-marker-header",
    title:
      "A worker on an offline machine, opened: its header keeps the struck glyph and the machine's name in a crowded title bar, and the hover says where it runs, that it is offline, why and the fix",
    open: async (page) => {
      const made = await openMachineMarkers(page);
      await threadRow(page, made.inReview).click();
      await page.waitForURL(new RegExp(`/t/${made.inReview}$`));
      await page.getByTestId("pane-machine").first().hover();
      await page.locator('[data-slot="tooltip-content"][data-open]').waitFor();
      await page.waitForTimeout(400);
    },
  },
];
