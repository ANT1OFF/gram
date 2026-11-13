import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import { chromium, expect, test, type Page } from "@playwright/test";

import { startHarness, type Harness } from "./harness";

// The page a thread's agent drives in the server's own headless browser, watched and taken over
// from a browser tab. The server forks the browser host from this checkout's sources and runs
// the Chromium Playwright has, or the one `GRAM_BROWSER_EXECUTABLE` names.
test.describe.configure({ mode: "serial" });

const HOST = fileURLToPath(
  new URL("../../../packages/shell/src/modules/agent-browser/headless-host.ts", import.meta.url),
);

let h: Harness;
let page: Page;
let app: Server;
let appUrl = "";

test.beforeAll(async ({ browser }) => {
  // The agent's "dev server": one page that says in its title what was done to it.
  app = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<title>Invoices</title><body style="margin:0" onkeydown="document.title='Typed '+event.key">` +
        `<button style="position:fixed;inset:0;width:100%;height:100%;font-size:48px" onclick="document.title='Pressed'">Filters</button>`,
    );
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  appUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
  h = await startHarness({
    env: {
      GRAM_HEADLESS_BROWSER: HOST,
      GRAM_BROWSER_EXECUTABLE: process.env["GRAM_BROWSER_EXECUTABLE"] ?? chromium.executablePath(),
      // Chromium's own sandbox doesn't start for root, as in a container.
      GRAM_BROWSER_SANDBOX: process.getuid?.() === 0 ? "0" : "1",
    },
  });
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await h?.stop();
  app?.close();
});

test("the Preview tab shows the agent's page from the server, and a click takes it over", async () => {
  const testInfo = test.info();
  await h.open(page, "/new");
  await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
  await expect(page.getByTestId("where-folder")).toHaveText("web");
  await page.getByRole("combobox", { name: "First prompt" }).fill("Check the filters");
  await page.getByRole("button", { name: "Start chat" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByText("echo: Check the filters")).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message" });
  await composer.fill(`/call browser_navigate ${JSON.stringify({ url: appUrl })}`);
  await composer.press("Enter");

  // The agent browsing brings the Preview tab up by itself.
  const panel = page.getByTestId("right-panel");
  const preview = panel.getByTestId("server-preview");
  await expect(preview).toHaveAttribute("data-state", "agent", { timeout: 30_000 });
  await expect(preview.getByTestId("preview-address")).toHaveValue(appUrl);
  const frame = preview.getByTestId("server-preview-frame");
  await expect(frame).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await expect(preview.getByTestId("server-preview-hint")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("agent.png") });

  // A click in the page reaches the page, and makes it yours.
  await frame.click();
  await expect(preview).toHaveAttribute("data-state", "yours");
  await expect(preview.getByTestId("preview-address")).toHaveAttribute("title", "Pressed");
  await expect(preview.getByTestId("server-preview-yours")).toBeVisible();
  await page.keyboard.press("g");
  await expect(preview.getByTestId("preview-address")).toHaveAttribute("title", "Typed g");
  await page.screenshot({ path: testInfo.outputPath("yours.png") });

  // While it is yours the agent's input is refused, and Hand back gives it the page again.
  await composer.fill(`/call browser_click ${JSON.stringify({ coordinate: [10, 10] })}`);
  await composer.press("Enter");
  await expect(page.getByText(/user has control/i).first()).toBeVisible();
  await preview
    .getByRole("button", { name: "You have control. Hand the page back to the agent" })
    .click();
  await expect(preview).toHaveAttribute("data-state", "agent");
});
