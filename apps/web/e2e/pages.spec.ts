import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// The user pins a page a worker drafted, from the Preview tab; it opens in the Pages tab under
// Gram's own header, and an agent's newer version waits for the user's Show it. The mock API keeps
// pages in memory and the mock shell draws each as a sandboxed iframe; nothing leaves the page.

/** Where screenshots go when asked for (`PAGES_SHOTS=<dir>`); none otherwise. */
const SHOTS = process.env["PAGES_SHOTS"];

let server: Server;
let port: number;

// Where the server's preview listener would serve the worker's draft: the spec's own page.
test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Release radar</title><h1>Release radar draft</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const shoot = async (page: Page, name: string) => {
  if (SHOTS === undefined) return;
  await page.mouse.move(700, 120);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** The report scenario's worker, opened from its orchestrator's feature card as a user would. */
const start = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.waitForFunction(() => window.gramMock !== undefined);
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("report"));
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("link", { name: "Return rate-limit headers" })
    .first()
    .click({ modifiers: ["ControlOrMeta"] });
  await page.waitForURL(new RegExp(`/t/${made.workerThreadId}$`));
  return made;
};

const DRAFT = "/tmp/gram-pages/release-radar/index.html";
const PIN = "Pin to Pages: keep a copy of this page in Gram";
const pageView = (page: Page) => page.locator('[data-testid="mock-page-view"]');

test("the user pins a drafted page, and an agent's newer version waits for Show it", async ({
  page,
}) => {
  const made = await start(page);
  await page.evaluate(
    ({ thread, html, url }) => {
      const mock = window.gramMock!;
      mock.previewUrls[html] = url;
      mock.simulateWrittenFile(thread as never, html, "<h1>Release radar draft</h1>");
    },
    { thread: made.workerThreadId, html: DRAFT, url: `http://127.0.0.1:${port}/` },
  );
  await page.getByRole("button", { name: "Open index.html" }).click();
  await expect(page.getByTestId("preview-address")).toHaveValue(DRAFT);
  const pin = page.getByRole("button", { name: PIN });
  await expect(pin).toBeVisible();
  await shoot(page, "1-preview-pin");

  await pin.click();
  // The Pages tab, on the page, under Gram's header naming it and the thread that made it.
  await expect(page.getByRole("tab", { name: "Pages", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const view = page.getByTestId("page-view");
  await expect(view).toHaveAttribute("data-version", "1");
  await expect(page.getByTestId("page-title")).toHaveText("index");
  await expect(page.getByTestId("page-meta")).toContainText("Made in");
  await expect(pageView(page)).toBeVisible();
  await expect(pageView(page)).toHaveAttribute(
    "data-url",
    /\/gram-pages\/.*-v1-token\/index\.html$/,
  );
  await expect(page.getByTestId("page-offer")).toHaveCount(0);
  await shoot(page, "2-pinned");

  // An agent offers a version: a notice, and the page the user has stays as it is.
  const pageId = await view.getAttribute("data-page-id");
  await page.evaluate(
    ({ thread, id }) => window.gramMock!.simulateOfferPage(thread as never, id as never, "Radar"),
    { thread: made.workerThreadId, id: pageId },
  );
  const offer = page.getByTestId("page-offer");
  await expect(offer).toContainText("Newer version from");
  await expect(view).toHaveAttribute("data-version", "1");
  await expect(pageView(page)).toHaveAttribute("data-url", /-v1-token\//);
  await shoot(page, "3-offer");

  await offer.getByRole("button", { name: "Show it" }).click();
  await expect(view).toHaveAttribute("data-version", "2");
  await expect(page.getByTestId("page-offer")).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Radar");
  await expect(pageView(page)).toHaveAttribute("data-url", /-v2-token\//);

  // Back to the list, then unpin: the list is empty again and the shell's view is closed.
  await page.getByTestId("page-unpin").click();
  await expect(page.getByTestId("pages-empty")).toBeVisible();
  await expect(pageView(page)).toHaveCount(0);
});

test("a thread outside a workspace offers no pin", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 720 });
  await page.goto("/t/t-deps");
  await page.waitForFunction(() => window.gramMock !== undefined);
  const dashboard = "/tmp/gram-report/dashboard.html";
  await page.evaluate(
    ({ html, url }) => {
      const mock = window.gramMock!;
      mock.previewUrls[html] = url;
      mock.simulateWrittenFile("t-deps" as never, html, "<h1>Dashboard</h1>");
    },
    { html: dashboard, url: `http://127.0.0.1:${port}/` },
  );
  await page.getByRole("button", { name: "Open dashboard.html" }).click();
  await expect(page.getByTestId("preview-address")).toHaveValue(dashboard);
  await expect(page.locator('[data-testid="mock-preview-view"]')).toBeVisible();
  await expect(page.getByRole("button", { name: PIN })).toHaveCount(0);
});
