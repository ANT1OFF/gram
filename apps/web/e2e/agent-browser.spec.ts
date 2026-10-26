import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type CDPSession } from "@playwright/test";

// The shells drive an agent's page over CDP (`webContents.debugger`), and Electron has no test
// runner in CI; Playwright's Chromium speaks the same protocol, so the shell's driver itself runs
// here, against a static page on loopback. Only this spec reads it (the tsconfig reference); the
// web app's bundle never does.
import { createPageDriver, type Cdp } from "../../../packages/shell/src/core/page-driver";

import type { DesktopPreview, BrowserViewportPreset, PaneResult } from "@gram/contracts";
import { EventEmitter } from "node:events";
import { createAgentPanes } from "../../../packages/shell/src/modules/agent-browser/pane";
import { createBrowseHostList } from "../../../packages/shell/src/core/browse-rules";
import { threadRow } from "./thread-row";

const HOST = "organization.example.invalid";

test("an agent's request for a new host asks once, and Always lists it under Agent may browse", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate((host) => {
    window.gramMock?.simulateBrowseApproval("t-deps" as never, host);
  }, HOST);

  const card = page.getByTestId("approval-card");
  await expect(card).toContainText(`Let the agent open ${HOST} in the Preview pane?`);
  await expect(card).toContainText("Settings → Agent may browse");
  await card.getByRole("button", { name: `Always for ${HOST}` }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.gramMock?.agentBrowseHosts)).toEqual([HOST]);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const hosts = page.getByTestId("agent-browse-hosts");
  const row = hosts.getByRole("listitem", { name: HOST });
  await expect(row).toBeVisible();
  // Trusting an agent on a site is not trusting its links to open.
  await expect(page.getByText("No trusted hosts: every link asks before it opens.")).toBeVisible();

  await row.getByRole("button", { name: `Agent browse host ${HOST} actions` }).click();
  await page.getByRole("menuitem", { name: "Stop allowing" }).click();
  await expect(
    page.getByText("No hosts: an agent asks before it opens any public site."),
  ).toBeVisible();

  // Allow once leaves the list as it was.
  await page.goBack();
  await page.evaluate(() => {
    window.gramMock?.simulateBrowseApproval("t-deps" as never, "news.example.org", "b2");
  });
  await page.getByTestId("approval-allow").click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  expect(await page.evaluate(() => window.gramMock?.agentBrowseHosts)).toEqual([]);
});

const PAGE = `<!doctype html>
<html><head><title>Shop</title><style>body { font: 16px sans-serif; padding: 24px; } input, select, button { font: inherit; margin: 8px; } button { padding: 12px; }</style></head>
<body>
  <h1>Checkout</h1>
  <p id="status">Waiting</p>
  <p style="display:none">Hidden note</p>
  <form action="/pay" method="post">
    <label>Name <input name="name" /></label>
    <label>Size <select name="size"><option value="s">Small</option><option value="l">Large</option></select></label>
    <label><input type="checkbox" name="gift" /> Gift wrap</label>
    <button type="button" id="check">Check stock</button>
    <button type="submit">Pay now</button>
  </form>
  <script>
    document.getElementById("check").addEventListener("click", () => {
      document.getElementById("status").textContent = "In stock";
      console.log("checked", 2);
    });
    document.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      document.getElementById("status").textContent = "Paid " + new FormData(e.target).get("name");
    });
    // A page can't hide a submit button from the driver by redefining the DOM.
    Element.prototype.closest = () => null;
    setTimeout(() => { throw new Error("late failure"); }, 0);
  </script>
</body></html>`;

let server: Server | undefined;
let origin = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/failed/")) {
      res.writeHead(503).end("synthetic response secret must not be exposed");
      return;
    }
    if (req.url?.startsWith("/abort/")) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
});

test("the agent's page shows as it is, and the header hands it back after the user took over", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.waitForFunction(() => window.gramMock !== undefined);
  // The user's page, then the agent's own, opened in the pane by browser_navigate.
  await page.evaluate(
    (url) => window.gramMock!.simulateShowPanel("t-deps" as never, "preview", url),
    origin,
  );
  await expect(page.getByTestId("preview-address")).toHaveValue(`${origin}/`);
  await page.evaluate(() => window.gramMock!.shell.preview!.drive("t-deps", "agent"));
  const opened = await page.evaluate(() => window.gramMock!.shell.preview!.opened.length);
  await page.evaluate(
    (url) => window.gramMock!.simulateShowPanel("t-deps" as never, "preview", url, true),
    `${origin}/`,
  );
  await expect(page.getByTestId("preview-driver")).toHaveAttribute("data-driver", "agent");
  expect(await page.evaluate(() => window.gramMock!.shell.preview!.opened.length)).toBe(opened);

  // The agent says what its input is for, and that it records; the user follows in the header.
  await page.evaluate(() =>
    window.gramMock!.shell.preview!.act("t-deps", "Opens the Filters menu", true),
  );
  await expect(page.getByTestId("preview-action")).toHaveText("Opens the Filters menu");
  await expect(page.getByTestId("preview-recording")).toBeVisible();

  // User takeover hides the agent action; the recording stays armed and visible.
  await page.evaluate(() => window.gramMock!.shell.preview!.drive("t-deps", "user"));
  await expect(page.getByTestId("preview-action")).toHaveCount(0);
  await expect(page.getByTestId("preview-recording")).toBeVisible();
  const handBack = page.getByRole("button", {
    name: "You have control. Hand the page back to the agent",
  });
  await handBack.click();
  await expect(page.getByTestId("preview-driver")).toHaveAttribute("data-driver", "agent");
  expect(await page.evaluate(() => window.gramMock!.shell.preview!.handedBack)).toEqual(["t-deps"]);
  await expect(page.getByTestId("preview-action")).toHaveText("Opens the Filters menu");
  await expect(page.getByTestId("preview-recording")).toBeVisible();

  // An explicit stop clears the recording, independent of who drives.
  await page.evaluate(() => window.gramMock!.shell.preview!.drive("t-deps", "user"));
  await page.evaluate(() => window.gramMock!.shell.preview!.act("t-deps", undefined, false));
  await expect(page.getByTestId("preview-activity")).toHaveCount(0);
});

const cdpOf = (session: CDPSession): Cdp => ({
  send: (method, params) => session.send(method as never, params as never),
  on: (event, listener) => {
    session.on(event as never, listener as never);
    return () => session.off(event as never, listener as never);
  },
});

/** The ref the outline gives the line matching `pattern`. */
const refOf = (outline: string, pattern: RegExp) => {
  const line = outline.split("\n").find((l) => pattern.test(l));
  const ref = line === undefined ? undefined : /\[(ref_\d+)\]/.exec(line)?.[1];
  if (ref === undefined) throw new Error(`no line matching ${pattern} in\n${outline}`);
  return ref;
};

test("the driver reads and acts on a static page on loopback the way a person would", async ({
  page,
}) => {
  const session = await page.context().newCDPSession(page);
  const driver = await createPageDriver(cdpOf(session));
  await page.goto(origin);
  await expect(page.getByText("Waiting")).toBeVisible();

  const outline = await driver.snapshot();
  expect(outline).toContain('- heading "Checkout"');
  expect(outline).toMatch(/- button "Pay now" \[ref_\d+\]/);
  expect(outline).not.toContain("Hidden note");
  expect(await driver.find("check stock")).toMatch(/^- button "Check stock" \[ref_\d+\]$/);

  const text = await driver.text();
  expect(text).toContain("Checkout");
  expect(text).not.toContain("Hidden note");

  // Fill the form in, as the user would.
  await driver.type("Ada", refOf(outline, /textbox "Name"/), false);
  await driver.formInput(refOf(outline, /combobox "Size"/), "Large");
  await driver.formInput(refOf(outline, /checkbox "Gift wrap"/), true);
  await expect(page.getByLabel("Name")).toHaveValue("Ada");
  await expect(page.getByLabel("Size")).toHaveValue("l");
  await expect(page.getByLabel("Gift wrap")).toBeChecked();

  // A plain button isn't a submission; the form's own button is, whatever the page redefined.
  const check = refOf(outline, /button "Check stock"/);
  const pay = refOf(outline, /button "Pay now"/);
  expect(await driver.clickSubmits({ ref: check })).toBeUndefined();
  expect(await driver.clickSubmits({ ref: pay })).toEqual({
    action: `${origin}/pay`,
    control: "Pay now",
  });
  expect(await driver.enterSubmits(refOf(outline, /textbox "Name"/))).toMatchObject({
    action: `${origin}/pay`,
  });

  await driver.click({ ref: check });
  await expect(page.locator("#status")).toHaveText("In stock");
  await driver.click({ ref: pay });
  await expect(page.locator("#status")).toHaveText("Paid Ada");

  expect(driver.console(false)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: "log", text: "2 console argument(s); contents omitted." }),
      expect.objectContaining({
        level: "error",
        text: "Uncaught page exception; contents omitted.",
      }),
    ]),
  );
  expect(driver.console(true).every((entry) => entry.level === "error")).toBe(true);

  const shot = await driver.screenshot();
  expect(shot.mimeType).toBe("image/jpeg");
  expect(Buffer.from(shot.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

  // A new document's refs are gone until the next snapshot.
  driver.reset();
  await expect(driver.click({ ref: pay })).rejects.toThrow("take a new snapshot");
  driver.dispose();
});

test("actual captures, measured targets and dispatch failures keep separate truthful evidence", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 900, height: 650 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  let failMouse = false;
  const cdp = cdpOf(session);
  const driver = await createPageDriver({
    ...cdp,
    send: (method, params) => {
      if (failMouse && method === "Input.dispatchMouseEvent")
        return Promise.reject(new Error("synthetic dispatch failure with token=secret"));
      return cdp.send(method, params);
    },
  });
  await page.goto(origin);
  const outline = await driver.snapshot();
  const check = refOf(outline, /button "Check stock"/);
  const before = Date.now();
  const shot = await driver.screenshot({ ref: check });
  const capture = driver.inspection().capture!;
  expect(capture.startedAt).toBeGreaterThanOrEqual(before);
  expect(capture.completedAt).toBeGreaterThanOrEqual(capture.startedAt);
  expect(capture.viewport).toMatchObject({ width: 900, height: 650, scale: 1 });
  const actualDimensions = await page.evaluate(
    (data) =>
      new Promise<{ width: number; height: number }>((resolve) => {
        const img = new Image();
        img.addEventListener(
          "load",
          () => resolve({ width: img.naturalWidth, height: img.naturalHeight }),
          { once: true },
        );
        img.src = `data:image/jpeg;base64,${data}`;
      }),
    shot.data,
  );
  expect(capture.imageWidth).toBe(actualDimensions.width);
  expect(capture.imageHeight).toBe(actualDimensions.height);
  expect(actualDimensions).toEqual({ width: 900, height: 650 });
  expect(capture.target).toMatchObject({ source: "dom-ref", ref: check });
  const box = await page.locator("#check").boundingBox();
  expect(capture.target!.region!.x).toBeCloseTo(box!.x, 0);
  expect(capture.target!.region!.y).toBeCloseTo(box!.y, 0);
  await driver.click({ coordinate: [box!.x + box!.width / 2, box!.y + box!.height / 2] });
  await expect(page.locator("#status")).toHaveText("In stock");
  expect(driver.inspection().action).toMatchObject({
    status: "dispatch-completed",
    target: { source: "coordinate", point: [box!.x + box!.width / 2, box!.y + box!.height / 2] },
  });
  expect(driver.inspection().capture!.id).toBe(capture.id);
  expect(driver.inspection().action!.dispatchStartedAt).toBeGreaterThanOrEqual(capture.completedAt);
  expect(Buffer.from(shot.data, "base64").length).toBeGreaterThan(1000);
  await driver.click({ ref: check });
  expect(driver.inspection().action).toMatchObject({
    target: { source: "dom-ref", ref: check, region: expect.any(Object), point: expect.any(Array) },
  });
  await page.evaluate(() => {
    document.body.style.paddingTop = "1000px";
    document.getElementById("check")!.scrollIntoView({ block: "center" });
  });
  await driver.screenshot({ ref: check });
  const scrolled = driver.inspection().capture!;
  const scrolledBox = await page.locator("#check").boundingBox();
  expect(scrolled.viewport.pageY).toBeGreaterThan(0);
  expect(scrolled.target!.region!.y).toBeCloseTo(scrolledBox!.y, 0);
  await driver.click({ ref: check });
  expect(driver.inspection().action!.target!.point![1]).toBeCloseTo(
    scrolledBox!.y + scrolledBox!.height / 2,
    0,
  );
  await page.evaluate(() => {
    document.body.style.paddingTop = "24px";
    window.scrollTo(0, 0);
  });
  await driver.viewport("phone");
  await driver.screenshot({ region: { x: 0, y: 0, width: 120, height: 90 } });
  expect(driver.inspection().capture!.viewport).toMatchObject({ width: 390, height: 844 });
  expect(driver.inspection().capture!.target!.source).toBe("region");
  await expect(
    driver.screenshot({ region: { x: 380, y: 0, width: 20, height: 20 } }),
  ).rejects.toThrow("outside");
  await driver.viewport("pane");
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
  await driver.screenshot();
  expect(driver.inspection().capture!.viewport.scale).toBe(1.5);
  // Chromium's capture may reset page scaling; establish the next operation's actual state.
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
  await expect(driver.screenshot({ ref: check })).rejects.toThrow("zoomed");
  await expect(driver.click({ ref: check })).rejects.toThrow("zoomed");
  expect(driver.inspection().action!.status).toBe("not-dispatched");
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  failMouse = true;
  await expect(driver.click({ ref: check })).rejects.toThrow("synthetic dispatch failure");
  expect(driver.inspection().action).toMatchObject({
    status: "dispatch-unknown",
    failure: "dispatch-error",
    dispatchStartedAt: expect.any(Number),
  });
  const priorDocument = driver.inspection().action!.documentId;
  driver.reset();
  expect(driver.inspection().documentId).not.toBe(priorDocument);
  expect(driver.inspection().action!.documentId).toBe(priorDocument);
  await expect(driver.click({ ref: check })).rejects.toThrow("new snapshot");
  expect(driver.inspection().action).toMatchObject({
    status: "not-dispatched",
    failure: "target-unavailable",
  });
  expect(driver.inspection().action!.dispatchStartedAt).toBeUndefined();
  driver.dispose();
  await context.close();
});

test("real page console and HTTP/transport failures never expose raw payloads or credential URLs", async ({
  page,
}) => {
  const session = await page.context().newCDPSession(page);
  const driver = await createPageDriver(cdpOf(session));
  await page.goto(origin);
  await page.evaluate(async () => {
    console.error("Authorization: Bearer invented-secret", {
      cookie: "invented-cookie",
      body: "invented-body",
    });
    await fetch("/failed/invented-path-token?opaque=invented-query-token", {
      headers: { Authorization: "Bearer invented-header" },
    });
    await fetch("/abort/invented-abort-token?key=invented-key").catch(() => {});
  });
  await expect
    .poll(() => driver.inspection(true).diagnostics!.network.length)
    .toBeGreaterThanOrEqual(2);
  const diagnostics = driver.inspection(true).diagnostics!;
  expect(diagnostics.network).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: origin,
        kind: "http",
        status: 503,
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({ url: origin, kind: "transport", durationMs: expect.any(Number) }),
    ]),
  );
  const serialized = JSON.stringify(diagnostics);
  expect(serialized).not.toMatch(/invented-|Authorization|Bearer|cookie|body|opaque/);
  expect(diagnostics.console.some((line) => line.level === "error")).toBe(true);
  driver.holdConsole(Date.now() - 10000);
  expect(driver.inspection(true).diagnostics!.network).toEqual([]);
  expect(driver.console(false)).toEqual([]);
  await page.evaluate(() => console.log("held secret"));
  expect(driver.console(false)).toEqual([]);
  driver.dispose();
});

test("actual pane policy keeps inspection out of file previews and viewport changes behind ownership", async ({
  page,
}) => {
  const session = await page.context().newCDPSession(page);
  const events = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  let attached = false;
  let takeOverOnMove = false;
  session.on("Runtime.consoleAPICalled", (p) =>
    debuggerEvents.emit("message", {}, "Runtime.consoleAPICalled", p),
  );
  const cdp = cdpOf(session);
  const subscriptions = new Map<string, () => void>();
  const contents = Object.assign(events, {
    isDestroyed: () => page.isClosed(),
    getURL: () => page.url(),
    getTitle: () => "Owned fake page",
    isLoading: () => false,
    loadURL: async (url: string) => {
      await page.goto(url);
      events.emit("did-navigate", {}, url);
    },
    navigationHistory: { canGoBack: () => false },
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
        debuggerEvents.emit("detach");
      },
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        // Mirror debugger's event subscription for every enabled domain.
        for (const event of [
          "Network.requestWillBeSent",
          "Network.responseReceived",
          "Network.loadingFinished",
          "Network.loadingFailed",
          "Runtime.exceptionThrown",
          "Runtime.executionContextsCleared",
          "Runtime.executionContextDestroyed",
          "Page.frameRequestedNavigation",
          "Page.frameNavigated",
        ]) {
          if (!subscriptions.has(event))
            subscriptions.set(
              event,
              cdp.on(event, (p) => debuggerEvents.emit("message", {}, event, p)),
            );
        }
        if (
          takeOverOnMove &&
          method === "Input.dispatchMouseEvent" &&
          params?.["type"] === "mouseMoved"
        ) {
          takeOverOnMove = false;
          panes.takeOver("owned");
        }
        return cdp.send(method, params);
      },
    }),
  });
  const panes = createAgentPanes({
    hosts: createBrowseHostList({ load: () => [], save: () => {}, changed: () => {} }),
    views: { contentsFor: () => contents as never },
    log: { warn: () => {}, info: () => {} } as never,
    resolveHost: async () => ({ endpoints: [{ address: "127.0.0.1" }] }) as never,
  });
  const command = (input: unknown) =>
    panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: true }, command: input });
  expect((await command({ op: "navigate", url: origin })).ok).toBe(true);
  expect(panes.inspectionOf("owned")!.capabilities.version).toBe(1);
  panes.takeOver("owned");
  expect(await command({ op: "viewport", preset: "phone" })).toMatchObject({
    ok: false,
    code: "userHasControl",
  });
  expect(await command({ op: "click", coordinate: [20, 20] })).toMatchObject({
    ok: false,
    code: "userHasControl",
  });
  expect((await panes.inspect("owned")).ok).toBe(true);
  expect(panes.driverOf("owned")).toBe("user");
  panes.handBack("owned");
  expect((await command({ op: "viewport", preset: "phone" })).ok).toBe(true);
  const snapshot = await command({ op: "snapshot" });
  if (!snapshot.ok) throw new Error("snapshot unavailable");
  const check = refOf(snapshot.content!, /button "Check stock"/);
  takeOverOnMove = true;
  const interrupted = await command({ op: "click", ref: check });
  expect(interrupted).toMatchObject({
    ok: false,
    code: "userHasControl",
    inspection: { action: { status: "dispatch-unknown", failure: "user-control" } },
  });
  await expect(page.locator("#status")).toHaveText("Waiting");
  panes.handBack("owned");
  expect(
    await command({ op: "navigate", url: "https://login.microsoftonline.com/" }),
  ).toMatchObject({ ok: false, code: "refused" });
  expect(await command({ op: "navigate", url: "http://192.168.1.1/" })).toMatchObject({
    ok: false,
    code: "refused",
  });
  await page.goto(`${origin}/gram-preview-files/synthetic/index.html`);
  expect(await panes.inspect("owned")).toMatchObject({ ok: false, code: "refused" });
  expect(panes.inspectionOf("owned")).toBeUndefined();
  panes.closed("owned");
  subscriptions.forEach((off) => off());
});

for (const width of [1440, 480]) {
  test(`Preview inspection uses real fixture capture at ${width}px and keeps controls accessible`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await context.newPage();
    const session = await context.newCDPSession(fixture);
    const driver = await createPageDriver(cdpOf(session));
    await fixture.goto(origin);
    const outline = await driver.snapshot();
    const check = refOf(outline, /button "Check stock"/);
    await driver.click({ ref: check });
    await fixture.evaluate(async () => {
      console.error("secret console body");
      await fetch("/failed/secret-path?opaque=secret-query");
    });
    await page.exposeFunction(
      "ownedFixtureInspect",
      async (target: { ref?: string } | undefined) => {
        const image = await driver.screenshot(target);
        return { ok: true, page: null, image, inspection: driver.inspection(true) };
      },
    );
    await page.exposeFunction(
      "ownedFixtureViewport",
      async (preset: "pane" | "phone" | "tablet" | "desktop") => {
        await driver.viewport(preset);
        return { ok: true, page: null, inspection: driver.inspection() };
      },
    );
    await page.goto("/t/t-deps");
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await page.evaluate(
      (url) => window.gramMock!.simulateShowPanel("t-deps" as never, "preview", url),
      origin,
    );
    await expect(page.getByTestId("preview-address")).toHaveValue(`${origin}/`);
    // Old shells/mocks do not become available merely because a Preview exists.
    await expect(
      page.getByRole("button", { name: "Browser inspection unavailable on this page or shell" }),
    ).toBeDisabled();
    const observation = driver.inspection();
    await page.evaluate((inspection) => {
      const preview = window.gramMock!.shell.preview!;
      const bridge = preview as DesktopPreview;
      const owned = window as unknown as {
        ownedFixtureInspect: (target?: { ref?: string }) => Promise<PaneResult>;
        ownedFixtureViewport: (preset: BrowserViewportPreset) => Promise<PaneResult>;
      };
      bridge.inspect = async (_id, target) => {
        const result = await owned.ownedFixtureInspect(target);
        if (result.ok && result.inspection !== undefined)
          preview.observeInspection("t-deps", result.inspection);
        return result;
      };
      bridge.viewport = async (_id, preset) => {
        const result = await owned.ownedFixtureViewport(preset);
        if (result.ok && result.inspection !== undefined)
          preview.observeInspection("t-deps", result.inspection);
        return result;
      };
      bridge.takeOver = (id) => preview.drive(id, "user");
      preview.observeInspection("t-deps", inspection);
      preview.drive("t-deps", "agent");
    }, observation);
    const takeOver = page.getByRole("button", {
      name: "Take control of this page; pause agent input",
    });
    await takeOver.focus();
    await expect(
      page.getByText("Take control of this page; pause agent input", { exact: true }),
    ).toBeVisible();
    await takeOver.click();
    await expect(page.getByTestId("preview-driver")).toHaveAttribute("data-driver", "user");
    await page
      .getByRole("button", { name: "You have control. Hand the page back to the agent" })
      .click();
    await expect(page.getByTestId("preview-driver")).toHaveAttribute("data-driver", "agent");
    await page
      .getByRole("button", { name: "Inspect page capture, action evidence and failures" })
      .click();
    const panel = page.getByRole("region", { name: "Browser inspection" });
    await panel.getByLabel("Element ref to annotate").fill(check);
    await panel.getByRole("button", { name: "Capture inspection screenshot" }).click();
    await expect(page.getByTestId("browser-target-annotation")).toBeVisible();
    await expect(page.getByTestId("browser-action-evidence")).toContainText(
      "Input dispatch acknowledged",
    );
    await expect(page.getByTestId("browser-network-failures")).toContainText("503");
    await expect(page.getByTestId("browser-network-failures")).not.toContainText("secret");
    await expect(page.getByTestId("browser-console-summary")).not.toContainText("secret");
    await expect(page.getByTestId("browser-capture-time")).toHaveText(
      /Captured \d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}/,
    );
    const annotated = await page.getByTestId("browser-target-annotation").boundingBox();
    const imageBox = await page.getByTestId("browser-capture-image").boundingBox();
    const region = driver.inspection().capture!.target!.region!;
    const viewport = driver.inspection().capture!.viewport;
    expect(annotated!.x - imageBox!.x).toBeCloseTo(
      (imageBox!.width * region.x) / viewport.width,
      0,
    );
    expect(annotated!.y - imageBox!.y).toBeCloseTo(
      (imageBox!.height * region.y) / viewport.height,
      0,
    );
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`browser-inspection-${width}.png`) });
    await panel.getByRole("button", { name: "Phone layout · 390 × 844" }).click();
    await expect.poll(() => driver.inspection().viewportPreset).toBe("phone");
    await panel.getByRole("button", { name: "Capture inspection screenshot" }).click();
    await expect(page.getByTestId("browser-capture-time")).toContainText("390 × 844 CSS pixels");
    await fixture.goto(`${origin}/?next-document`);
    await page.evaluate(
      (inspection) => window.gramMock!.shell.preview!.observeInspection("t-deps", inspection),
      driver.inspection(),
    );
    await expect(panel.getByText("This action belongs to an earlier document.")).toBeVisible();
    await expect(panel.getByText("This capture belongs to an earlier document.")).toBeVisible();
    await panel.getByLabel("Element ref to annotate").fill("ref_99999");
    await panel.getByRole("button", { name: "Capture inspection screenshot" }).click();
    await expect(panel.getByRole("alert")).toContainText("outcome is unknown");
    await expect(page.getByTestId("browser-target-annotation")).toHaveCount(0);
    // Attached capability may disappear after a capture (revocation, navigation or detach).
    // Restore the live view immediately, discard the inspector image and retain a usable exit.
    await page.evaluate(() =>
      window.gramMock!.shell.preview!.observeInspection("t-deps", undefined),
    );
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Browser inspection became unavailable" }),
    ).toBeVisible();
    await expect(page.getByTestId("browser-capture-image")).toHaveCount(0);
    await expect(page.getByTestId("preview-placeholder")).toHaveAttribute("data-showing", "true");
    await expect(page.getByTestId("mock-preview-view")).toBeVisible();
    const exit = page.getByRole("button", { name: "Close browser inspection" });
    await expect(exit).toBeEnabled();
    await exit.focus();
    await exit.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Browser inspection became unavailable" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Browser inspection unavailable on this page or shell" }),
    ).toBeDisabled();
    await expect(page.getByTestId("preview-placeholder")).toHaveAttribute("data-showing", "true");
    driver.dispose();
    await fixture.close();
  });
}
