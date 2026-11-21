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
  await page.evaluate(([ids, viaServer, logo]) => {
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
  }, [made, hosted, HOSTED_LOGO] as const);
  await threadRow(page, made.working).getByTestId("overview-worker-machine").waitFor();
  return made;
};

export const MACHINE_MARKER_SHOTS: readonly Shot[] = [
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
