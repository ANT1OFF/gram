import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { threadRow } from "./thread-row";

let server: Server;
let port: number;

// The thread's local app: a static page on loopback, as a dev server would serve it.
test.beforeAll(async () => {
  server = createServer((request, response) => {
    const other = request.url?.startsWith("/other") === true;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      other
        ? "<title>Other</title><h1>The other page</h1>"
        : "<title>Local app</title><h1>Hello from the local app</h1>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Opens the thread once the mock API is up, which specs drive it through. */
async function openThread(page: Page, threadId: string) {
  // A solo thread's header shares the title bar with the window's controls, and drops its fork
  // link and port chips when narrow: a wide window keeps them in sight.
  await page.setViewportSize({ width: 1680, height: 720 });
  await page.goto(`/t/${threadId}`);
  await expect(threadRow(page, threadId)).toBeVisible();
  await page.waitForFunction(() => window.gramMock !== undefined);
}

const view = (page: Page, threadId: string) =>
  page.locator(`[data-testid="mock-preview-view"][data-thread="${threadId}"]`);

test("a port chip opens the thread's app in the Preview tab, loopback only", async ({ page }) => {
  await openThread(page, "t-deps");
  await page.evaluate((p) => window.gramMock!.simulatePorts("t-deps" as never, [p]), port);

  await page.getByTestId(`port-chip-${port}`).first().click();
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const frame = view(page, "t-deps");
  await expect(frame).toBeVisible();
  await expect(
    page.frameLocator('[data-thread="t-deps"]').getByRole("heading", { level: 1 }),
  ).toHaveText("Hello from the local app", { timeout: 10_000 * slowdown });
  await expect(page.getByTestId("preview-address")).toHaveValue(`http://localhost:${port}/`);

  // The page sits where the tab's placeholder is.
  const placeholder = await page.getByTestId("preview-placeholder").boundingBox();
  const drawn = await frame.boundingBox();
  expect(drawn).not.toBeNull();
  expect(Math.abs(drawn!.x - placeholder!.x)).toBeLessThan(2);
  expect(Math.abs(drawn!.width - placeholder!.width)).toBeLessThan(2);

  // A dialog over it hides the page, which would otherwise draw over the dialog.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(frame).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await expect(frame).toBeVisible();

  // The agent's show_panel opens the tab on its URL.
  await page.evaluate(
    (url) => window.gramMock!.simulateShowPanel("t-deps" as never, "preview", url),
    `http://127.0.0.1:${port}/other`,
  );
  await expect(
    page.frameLocator('[data-thread="t-deps"]').getByRole("heading", { level: 1 }),
  ).toHaveText("The other page");
  await expect(page.getByTestId("preview-address")).toHaveValue(`http://127.0.0.1:${port}/other`);

  // An address off loopback doesn't open here.
  const address = page.getByTestId("preview-address");
  await address.fill("https://organization.example.invalid/");
  await address.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "Only an address on localhost opens here, such as localhost:3000, or the full path of a Markdown or HTML file.",
  );
  await expect(page.getByTestId("preview-address")).toHaveValue(`http://127.0.0.1:${port}/other`);

  // A loopback address typed without its scheme opens, as the placeholder shows it.
  await address.fill(`localhost:${port}`);
  await address.press("Enter");
  await expect(page.getByTestId("preview-address")).toHaveValue(`http://localhost:${port}/`);
  await expect(
    page.frameLocator('[data-thread="t-deps"]').getByRole("heading", { level: 1 }),
  ).toHaveText("Hello from the local app");
});

test("each thread keeps its own page, loaded while another thread shows", async ({ page }) => {
  await openThread(page, "t-deps");
  await page.evaluate((p) => {
    window.gramMock!.simulatePorts("t-deps" as never, [p]);
    window.gramMock!.simulatePorts("t-flaky" as never, [p]);
  }, port);
  // The thread's header carries its port chips.
  await page.getByTestId("pane-header").getByTestId(`port-chip-${port}`).click();
  await expect(view(page, "t-deps")).toBeVisible();

  await threadRow(page, "t-flaky").click();
  await expect(view(page, "t-deps")).toBeHidden();
  // A thread whose tab hasn't opened anything offers its ports.
  await expect(page.getByTestId("preview-empty")).toBeVisible();
  await page
    .getByTestId("preview-empty")
    .getByRole("button", { name: `:${port}` })
    .click();
  await expect(view(page, "t-flaky")).toBeVisible();

  await threadRow(page, "t-deps").click();
  await expect(view(page, "t-deps")).toBeVisible();
  await expect(view(page, "t-flaky")).toBeHidden();
  // Coming back shows the page as it was, without loading it again.
  const opened = await page.evaluate(() => window.gramMock!.shell.preview.opened.slice());
  expect(opened).toEqual([`t-deps http://localhost:${port}/`, `t-flaky http://localhost:${port}/`]);
});

test("a Markdown or HTML file the agent wrote gets a card that renders it in the Preview tab", async ({
  page,
}) => {
  await openThread(page, "t-deps");
  const report = "/tmp/gram-report/REPORT.md";
  const dashboard = "/tmp/gram-report/dashboard.html";
  await page.evaluate(
    ({ md, html, url }) => {
      const mock = window.gramMock!;
      // Where the server's preview listener would serve it: here, the spec's own loopback page.
      mock.previewUrls[html] = url;
      mock.simulateWrittenFile("t-deps" as never, md, "# Quarterly report\n\nAll green.");
      mock.simulateWrittenFile("t-deps" as never, html, "<h1>Dashboard</h1>");
      mock.simulateWrittenFile("t-deps" as never, "/tmp/gram-report/notes.txt", "not a page");
    },
    { md: report, html: dashboard, url: `http://127.0.0.1:${port}/` },
  );
  const cards = page.getByTestId("preview-file-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("REPORT.md");
  await expect(cards.first()).toContainText("Markdown · /tmp/gram-report");
  await expect(cards.last()).toContainText("HTML page");

  // Markdown renders in the app itself, with no page of the shell's over it.
  await page.getByRole("button", { name: "Open REPORT.md" }).click();
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const markdown = page.getByTestId("preview-markdown");
  await expect(markdown.getByRole("heading", { name: "Quarterly report" })).toBeVisible();
  await expect(page.getByTestId("preview-address")).toHaveValue(report);
  await expect(view(page, "t-deps")).toHaveCount(0);

  // HTML loads as a page, in the shell's view, from where the server serves it.
  await page.getByRole("button", { name: "Open dashboard.html" }).click();
  await expect(view(page, "t-deps")).toBeVisible();
  await expect(
    page.frameLocator('[data-thread="t-deps"]').getByRole("heading", { level: 1 }),
  ).toHaveText("Hello from the local app", { timeout: 10_000 * slowdown });
  await expect(page.getByTestId("preview-address")).toHaveValue(dashboard);
  await expect(markdown).toHaveCount(0);

  // Back on the Markdown, the page goes out of sight again.
  await page.getByRole("button", { name: "Open REPORT.md" }).click();
  await expect(markdown).toBeVisible();
  await expect(view(page, "t-deps")).toBeHidden();
});

test("a file the agent wrote outside the checkout opens in Files where it isn't a page", async ({
  page,
}) => {
  await openThread(page, "t-deps");
  const report = "/tmp/gram-report/FALLBACK.md";
  await page.evaluate((md) => {
    const mock = window.gramMock!;
    mock.simulateWrittenFile("t-deps" as never, md, "# Fallback report\n");
    // What a Preview request without a Preview tab, or `show_panel files`, asks for.
    mock.simulateShowPanel("t-deps" as never, "files", md);
  }, report);
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Fallback report" })).toBeVisible();
});

test("a Markdown preview's link to another kind of file opens it in Files", async ({ page }) => {
  await openThread(page, "t-deps");
  const report = "/tmp/gram-report/LINKS.md";
  await page.evaluate((md) => {
    const mock = window.gramMock!;
    mock.simulateWrittenFile("t-deps" as never, md, "# Links\n\nSee [the script](build.ts).\n");
    mock.simulateWrittenFile("t-deps" as never, "/tmp/gram-report/build.ts", "export {};\n");
  }, report);
  await page.getByRole("button", { name: "Open LINKS.md" }).click();
  await page.getByTestId("preview-markdown").getByRole("link", { name: "the script" }).click();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("export {};")).toBeVisible();
});
