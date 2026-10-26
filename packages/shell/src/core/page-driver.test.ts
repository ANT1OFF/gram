import { describe, expect, it, vi } from "vitest";

import {
  consoleText,
  createPageDriver,
  findInOutline,
  RefTable,
  renderAxTree,
  type AxNode,
  type Cdp,
} from "./page-driver.ts";

const node = (
  nodeId: string,
  role: string,
  name: string,
  childIds: string[] = [],
  extra: Partial<AxNode> = {},
): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  ...extra,
});

const PAGE: AxNode[] = [
  { ...node("1", "RootWebArea", "Shop", ["2", "3"]) },
  { ...node("2", "generic", "", ["4", "5", "6"]), parentId: "1" },
  { ...node("3", "StaticText", "  Welcome   back "), parentId: "1" },
  { ...node("4", "heading", "Cart", [], { backendDOMNodeId: 40 }), parentId: "2" },
  {
    ...node("5", "textbox", "Coupon", [], {
      backendDOMNodeId: 50,
      value: { value: "SAVE10" },
      properties: [
        { name: "required", value: { value: true } },
        { name: "disabled", value: { value: false } },
      ],
    }),
    parentId: "2",
  },
  { ...node("6", "button", "Pay now", ["7"], { backendDOMNodeId: 60 }), parentId: "2" },
  { ...node("7", "StaticText", "Pay now", [], { ignored: true }), parentId: "6" },
];

describe("renderAxTree", () => {
  it("outlines what the page says, with a ref on every element and grouping lifted", () => {
    const refs = new RefTable();
    expect(renderAxTree(PAGE, refs)).toBe(
      [
        '- heading "Cart" [ref_1]',
        '- textbox "Coupon" [ref_2] value="SAVE10" required',
        '- button "Pay now" [ref_3]',
        '- text "Welcome back"',
      ].join("\n"),
    );
    expect(refs.nodeOf("ref_3")).toBe(60);
  });

  it("keeps a node's ref across snapshots until the page is reset", () => {
    const refs = new RefTable();
    renderAxTree(PAGE, refs);
    const moved = [...PAGE.slice(0, 3), PAGE[5]!, PAGE[4]!, PAGE[3]!, PAGE[6]!];
    expect(renderAxTree(moved, refs)).toContain('button "Pay now" [ref_3]');
    refs.clear();
    expect(refs.nodeOf("ref_3")).toBeUndefined();
    // The next page's elements get refs of their own, so an old one never names one of them.
    expect(renderAxTree(PAGE, refs)).toContain('heading "Cart" [ref_4]');
    expect(refs.nodeOf("ref_1")).toBeUndefined();
  });

  it("cuts a long page and says how to look further", () => {
    const many: AxNode[] = [node("r", "RootWebArea", "", ["a", "b", "c"])];
    for (const id of ["a", "b", "c"]) {
      many.push({
        ...node(id, "link", "x".repeat(30), [], { backendDOMNodeId: id.charCodeAt(0) }),
        parentId: "r",
      });
    }
    const outline = renderAxTree(many, new RefTable(), 100);
    expect(outline.split("\n")).toHaveLength(3);
    expect(outline).toContain("cut at 100 characters; use browser_find");
  });

  it("lists only interactive elements, flat, when asked", () => {
    const refs = new RefTable();
    const focusable: AxNode = {
      ...node("8", "generic", "", [], {
        backendDOMNodeId: 80,
        properties: [{ name: "focusable", value: { value: true } }],
      }),
      parentId: "2",
    };
    const page = [
      { ...PAGE[0]!, childIds: ["2", "3"] },
      { ...PAGE[1]!, childIds: ["4", "5", "6", "8"] },
      ...PAGE.slice(2),
      focusable,
    ];
    expect(renderAxTree(page, refs, { interactive: true })).toBe(
      [
        '- textbox "Coupon" [ref_1] value="SAVE10" required',
        '- button "Pay now" [ref_2]',
        "- generic [ref_3]",
      ].join("\n"),
    );
    expect(renderAxTree([node("r", "RootWebArea", "")], refs, { interactive: true })).toBe(
      "(nothing interactive here)",
    );
  });

  it("stops at a depth and outlines one subtree, saying what it left out", () => {
    const tree: AxNode[] = [
      node("r", "RootWebArea", "Docs", ["nav"]),
      { ...node("nav", "navigation", "Main", ["list"], { backendDOMNodeId: 1 }), parentId: "r" },
      { ...node("list", "list", "", ["item"], { backendDOMNodeId: 2 }), parentId: "nav" },
      { ...node("item", "listitem", "", ["link"], { backendDOMNodeId: 3 }), parentId: "list" },
      { ...node("link", "link", "Home", [], { backendDOMNodeId: 4 }), parentId: "item" },
    ];
    const refs = new RefTable();
    expect(renderAxTree(tree, refs, { depth: 2 })).toBe(
      [
        '- navigation "Main" [ref_1]',
        "  - list [ref_2]",
        "… (deeper levels left out at depth 2)",
      ].join("\n"),
    );
    expect(renderAxTree(tree, refs, { rootId: "item" })).toBe(
      ["- listitem [ref_3]", '  - link "Home" [ref_4]'].join("\n"),
    );
  });

  it("names an empty page", () => {
    expect(renderAxTree([node("r", "RootWebArea", "")], new RefTable())).toBe(
      "(the page has no accessible content)",
    );
  });
});

describe("findInOutline", () => {
  it("finds lines by role, name or value, ignoring case", () => {
    const outline = renderAxTree(PAGE, new RefTable());
    expect(findInOutline(outline, "PAY")).toBe('- button "Pay now" [ref_3]');
    expect(findInOutline(outline, "save10")).toContain("Coupon");
    expect(findInOutline(outline, "checkout")).toBe('(nothing on the page matches "checkout")');
  });
});

describe("consoleText", () => {
  it("prints arguments as the console would", () => {
    expect(
      consoleText([
        { type: "string", value: "loaded" },
        { type: "number", value: 3 },
        { type: "object", description: "Error: boom" },
        { type: "number", unserializableValue: "NaN" },
      ]),
    ).toBe("loaded 3 Error: boom NaN");
  });
});

describe("the page's console", () => {
  it("keeps nothing a held page logged, from when it was held, until it is kept again", async () => {
    const listeners = new Map<string, (params: unknown) => void>();
    const cdp: Cdp = {
      send: async () => ({}),
      on: (event, listener) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    };
    const driver = await createPageDriver(cdp);
    const say = (text: string) =>
      listeners.get("Runtime.consoleAPICalled")!({
        type: "log",
        args: [{ type: "string", value: text }],
      });
    vi.useFakeTimers({ now: 1000 });
    try {
      say("the app");
      vi.setSystemTime(2000);
      say("a late line, logged as the file preview started");
      // A file preview the user opened in the same view: held from when its navigation started.
      driver.holdConsole(2000);
      say("a sibling file's contents");
      expect(() => listeners.get("Runtime.exceptionThrown")!({})).not.toThrow();
      // Back on a page the agent may read.
      driver.holdConsole(null);
      vi.setSystemTime(3000);
      say("the app again");
      expect(driver.console(false).map((entry) => entry.text)).toEqual([
        "1 console argument(s); contents omitted.",
        "1 console argument(s); contents omitted.",
      ]);
    } finally {
      vi.useRealTimers();
      driver.dispose();
    }
  });

  it("starts held for a page the agent may not read, through what it logs as it attaches", async () => {
    const listeners = new Map<string, (params: unknown) => void>();
    const say = (text: string) =>
      listeners.get("Runtime.consoleAPICalled")?.({
        type: "log",
        args: [{ type: "string", value: text }],
      });
    const cdp: Cdp = {
      // The page logs while the driver is still enabling what it reads.
      send: async (method) => {
        say(`during ${method}`);
        return {};
      },
      on: (event, listener) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    };
    const driver = await createPageDriver(cdp, 0);
    say("still on the file");
    expect(driver.console(false)).toEqual([]);
    driver.holdConsole(null);
    say("an allowed page");
    expect(driver.console(false).map((entry) => entry.text)).toEqual([
      "1 console argument(s); contents omitted.",
    ]);
    driver.dispose();
  });
});

describe("driver input document freshness", () => {
  it("refuses unsupported and prototype-named keys, modifiers and repeats at the driver boundary", async () => {
    const sent: string[] = [];
    const driver = await createPageDriver({
      on: () => () => {},
      send: async (method) => {
        sent.push(method);
        return {};
      },
    });
    sent.length = 0;
    for (const key of ["toString", "__proto__", "Control+L", "ab", " "])
      await expect(driver.pressKey("ref_1", key)).rejects.toThrow("Unsupported key");
    await expect(driver.pressKey(undefined, "v", { modifiers: ["meta"] })).rejects.toThrow(
      "Clipboard shortcuts",
    );
    await expect(driver.pressKey(undefined, "a", { repeat: 101 })).rejects.toThrow(
      "Unsupported repeat",
    );
    await expect(
      driver.pressKey(undefined, "a", { modifiers: ["hasOwnProperty" as never] }),
    ).rejects.toThrow("Unsupported modifier");
    expect(sent).toEqual([]);
    driver.dispose();
  });
  it("sends no key when DOM focus acknowledgement leaves another element active", async () => {
    const keys: unknown[] = [];
    const cdp: Cdp = {
      on: () => () => {},
      send: async (method, params) => {
        if (method === "Accessibility.getFullAXTree")
          return {
            nodes: [
              {
                nodeId: "root",
                role: { value: "combobox" },
                name: { value: "Project" },
                backendDOMNodeId: 7,
              },
            ],
          };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "owned" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        if (method === "DOM.resolveNode") return { object: { objectId: "owned" } };
        if (method === "Runtime.callFunctionOn")
          return {
            result: { value: String(params?.["functionDeclaration"]).includes("ownerDocument") },
          };
        if (method === "Input.dispatchKeyEvent") keys.push(params);
        return {};
      },
    };
    const driver = await createPageDriver(cdp);
    expect(await driver.snapshot()).toContain("ref_1");
    await expect(driver.pressKey("ref_1", "ArrowDown")).rejects.toThrow("did not retain focus");
    expect(keys).toEqual([]);
    driver.dispose();
  });
  it("stops subsequent dispatch on a committed document even when ownership remains agent", async () => {
    const listeners = new Map<string, (params: unknown) => void>();
    const sent: string[] = [];
    const cdp: Cdp = {
      on: (event, listener) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      send: async (method, params) => {
        if (method === "Page.getLayoutMetrics")
          return {
            cssVisualViewport: {
              clientWidth: 500,
              clientHeight: 400,
              pageX: 0,
              pageY: 0,
              scale: 1,
            },
          };
        if (method === "Input.dispatchMouseEvent") {
          sent.push(String(params?.["type"]));
          if (params?.["type"] === "mouseMoved")
            listeners.get("Page.frameNavigated")?.({ frame: { id: "owned-next" } });
        }
        return {};
      },
    };
    const driver = await createPageDriver(cdp, null, () => true);
    const original = driver.inspection().documentId;
    await expect(driver.click({ coordinate: [20, 20] })).rejects.toThrow("page changed");
    expect(sent).toEqual(["mouseMoved"]);
    expect(driver.inspection().documentId).not.toBe(original);
    expect(driver.inspection().action).toMatchObject({
      documentId: original,
      status: "dispatch-unknown",
      failure: "dispatch-error",
    });
    driver.dispose();
  });
});

/** A fake CDP session answering what a driver asks, recording every command. */
const scripted = (
  answer: (method: string, params?: Record<string, unknown>) => unknown = () => undefined,
) => {
  const sent: { method: string; params?: Record<string, unknown> | undefined }[] = [];
  const listeners = new Map<string, (params: unknown) => void>();
  const cdp: Cdp = {
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    send: async (method, params) => {
      sent.push({ method, params });
      const custom = answer(method, params);
      if (custom !== undefined) return custom;
      switch (method) {
        case "Accessibility.getFullAXTree":
          return {
            nodes: [
              { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["box"] },
              {
                nodeId: "box",
                parentId: "root",
                role: { value: "textbox" },
                name: { value: "Search" },
                backendDOMNodeId: 7,
              },
            ],
          };
        case "Page.getFrameTree":
          return { frameTree: { frame: { id: "owned" } } };
        case "Page.createIsolatedWorld":
          return { executionContextId: 1 };
        case "DOM.resolveNode":
          return { object: { objectId: "owned" } };
        case "Runtime.callFunctionOn":
          return {
            result: {
              value: /ownerDocument|activeElement/.test(String(params?.["functionDeclaration"]))
                ? true
                : "Synthetic/1.0",
            },
          };
        case "DOM.getContentQuads":
          return { quads: [[10, 10, 50, 10, 50, 30, 10, 30]] };
        case "Page.getLayoutMetrics":
          return {
            cssVisualViewport: {
              clientWidth: 500,
              clientHeight: 400,
              pageX: 0,
              pageY: 0,
              scale: 1,
            },
          };
        default:
          return {};
      }
    },
  };
  return { cdp, sent, emit: (event: string, params: unknown) => listeners.get(event)?.(params) };
};
const of = (
  sent: { method: string; params?: Record<string, unknown> | undefined }[],
  method: string,
) => sent.filter((c) => c.method === method).map((c) => c.params);

describe("driver input primitives", () => {
  it("presses a key with modifiers and a repeat, typing nothing for a shortcut", async () => {
    const { cdp, sent } = scripted();
    const driver = await createPageDriver(cdp);
    await driver.snapshot();
    sent.length = 0;
    await driver.pressKey("ref_1", "a", { modifiers: ["meta"], repeat: 2 });
    expect(of(sent, "DOM.focus")).toEqual([{ backendNodeId: 7 }]);
    const keys = of(sent, "Input.dispatchKeyEvent");
    expect(keys).toHaveLength(4);
    expect(keys[0]).toEqual({
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 4,
    });
    expect(keys[1]).toMatchObject({ type: "keyUp", key: "a", modifiers: 4 });
    sent.length = 0;
    // Without a ref the key goes to the focused element, and a plain one types its text.
    await driver.pressKey(undefined, "Enter");
    expect(of(sent, "DOM.focus")).toEqual([]);
    expect(of(sent, "Input.dispatchKeyEvent")).toEqual([
      expect.objectContaining({ type: "keyDown", key: "Enter", text: "\r", modifiers: 0 }),
      expect.not.objectContaining({ text: expect.anything() }),
    ]);
    driver.dispose();
  });

  it("double and right clicks press the named button with rising click counts", async () => {
    const { cdp, sent } = scripted();
    const driver = await createPageDriver(cdp);
    await driver.click({ coordinate: [20, 20] }, { button: "right", double: true });
    expect(
      of(sent, "Input.dispatchMouseEvent").map((p) => [
        p?.["type"],
        p?.["button"],
        p?.["clickCount"],
      ]),
    ).toEqual([
      ["mouseMoved", undefined, undefined],
      ["mousePressed", "right", 1],
      ["mouseReleased", "right", 1],
      ["mousePressed", "right", 2],
      ["mouseReleased", "right", 2],
    ]);
    driver.dispose();
  });

  it("hovers, scrolls by notches and refuses points outside the viewport", async () => {
    const { cdp, sent } = scripted();
    const driver = await createPageDriver(cdp);
    await driver.hover({ coordinate: [30, 40] });
    await driver.scroll(undefined, "down", 3);
    await driver.scroll({ coordinate: [10, 10] }, "left", 1);
    expect(of(sent, "Input.dispatchMouseEvent")).toEqual([
      { type: "mouseMoved", x: 30, y: 40 },
      { type: "mouseWheel", x: 250, y: 200, deltaX: 0, deltaY: 300 },
      { type: "mouseWheel", x: 10, y: 10, deltaX: -100, deltaY: 0 },
    ]);
    expect(driver.inspection().action).toMatchObject({
      op: "scroll",
      status: "dispatch-completed",
    });
    await expect(driver.hover({ coordinate: [600, 10] })).rejects.toThrow("outside the viewport");
    driver.dispose();
  });

  it("drags with intermediate moves, and drops an intercepted HTML drag at its end", async () => {
    let emit!: (event: string, params: unknown) => void;
    const fake = scripted((method, params) => {
      if (
        method === "Input.dispatchMouseEvent" &&
        params?.["type"] === "mouseMoved" &&
        params["buttons"] === 1
      )
        emit("Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } });
      return undefined;
    });
    emit = fake.emit;
    const driver = await createPageDriver(fake.cdp);
    await driver.drag({ coordinate: [10, 10] }, { coordinate: [90, 50] });
    expect(fake.sent.map((c) => c.method).filter((m) => m.startsWith("Input."))).toEqual([
      "Input.setInterceptDrags",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchDragEvent",
      "Input.dispatchDragEvent",
      "Input.dispatchDragEvent",
      "Input.dispatchMouseEvent",
      "Input.setInterceptDrags",
    ]);
    expect(
      of(fake.sent, "Input.dispatchDragEvent").map((p) => [p?.["type"], p?.["x"], p?.["y"]]),
    ).toEqual([
      ["dragEnter", 90, 50],
      ["dragOver", 90, 50],
      ["drop", 90, 50],
    ]);
    expect(driver.inspection().action?.target).toMatchObject({
      point: [10, 10],
      toPoint: [90, 50],
    });
    driver.dispose();
  });

  it("captures at a smaller scale for a cheaper image", async () => {
    const { cdp, sent } = scripted((method) =>
      method === "Page.captureScreenshot"
        ? { data: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 9, 8, 0, 1, 0, 1, 0]).toString("base64") }
        : undefined,
    );
    const driver = await createPageDriver(cdp);
    await driver.screenshot({ scale: 0.25 });
    expect(of(sent, "Page.captureScreenshot")[0]).toMatchObject({
      clip: { x: 0, y: 0, width: 500, height: 400, scale: 0.25 },
    });
    driver.dispose();
  });

  it("emulates a custom size, a phone and a colour scheme, and undoes each", async () => {
    const { cdp, sent } = scripted();
    const driver = await createPageDriver(cdp);
    await driver.viewport({ size: { width: 375, height: 700 }, mobile: true, colorScheme: "dark" });
    expect(driver.inspection()).toMatchObject({
      emulation: { width: 375, height: 700, mobile: true, colorScheme: "dark" },
    });
    expect(driver.inspection().viewportPreset).toBeUndefined();
    expect(of(sent, "Emulation.setDeviceMetricsOverride")).toEqual([
      { width: 375, height: 700, deviceScaleFactor: 2, mobile: true },
    ]);
    expect(of(sent, "Emulation.setTouchEmulationEnabled")).toEqual([
      { enabled: true, maxTouchPoints: 5 },
    ]);
    expect(of(sent, "Emulation.setUserAgentOverride")[0]?.["userAgent"]).toMatch(/Android.*Mobile/);
    expect(of(sent, "Emulation.setEmulatedMedia")).toEqual([
      { features: [{ name: "prefers-color-scheme", value: "dark" }] },
    ]);
    // A wider size can't stay a phone.
    await expect(
      driver.viewport({ size: { width: 800, height: 700 }, mobile: true }),
    ).rejects.toThrow("below 768");
    sent.length = 0;
    await driver.viewport({ preset: "pane", colorScheme: "system" });
    expect(driver.inspection()).toMatchObject({
      viewportPreset: "pane",
      emulation: { mobile: false },
    });
    expect(sent.map((c) => c.method).filter((m) => m.startsWith("Emulation."))).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
      "Emulation.setEmulatedMedia",
    ]);
    // The page's own user agent comes back.
    expect(of(sent, "Emulation.setUserAgentOverride")).toEqual([{ userAgent: "Synthetic/1.0" }]);
    driver.dispose();
  });

  it("keeps a phone to a size below 768, and undoes a change that failed halfway", async () => {
    let failAgent = true;
    const { cdp, sent } = scripted((method) => {
      if (method === "Emulation.setUserAgentOverride" && failAgent) {
        failAgent = false;
        throw new Error("synthetic protocol failure");
      }
      return undefined;
    });
    const driver = await createPageDriver(cdp);
    await expect(driver.viewport({ mobile: true })).rejects.toThrow("below 768");
    await expect(
      driver.viewport({ size: { width: 375, height: 700 }, mobile: true }),
    ).rejects.toThrow("synthetic protocol failure");
    // The size and touch took, the agent didn't: the reset undoes exactly what took.
    sent.length = 0;
    await driver.viewport({ preset: "pane" });
    expect(sent.map((c) => c.method).filter((m) => m.startsWith("Emulation."))).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
    ]);
    await driver.viewport({ size: { width: 375, height: 700 } });
    sent.length = 0;
    await driver.viewport({ mobile: true });
    expect(sent.map((c) => c.method).filter((m) => m.startsWith("Emulation."))).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ]);
    expect(driver.inspection().emulation).toEqual({ width: 375, height: 700, mobile: true });
    driver.dispose();
  });

  it("waits until text shows, polling the page, and gives up at its deadline", async () => {
    let reads = 0;
    const { cdp } = scripted((method, params) =>
      method === "Runtime.callFunctionOn" &&
      String(params?.["functionDeclaration"]).includes("innerText")
        ? { result: { value: ++reads < 3 ? "Saving…" : "Saved" } }
        : undefined,
    );
    const driver = await createPageDriver(cdp);
    expect(await driver.waitFor(2_000, { text: "saved" })).toBe(true);
    expect(reads).toBe(3);
    expect(await driver.waitFor(200, { text: "never" })).toBe(false);
    driver.dispose();
  });
});

describe("local debugging reads", () => {
  it("lists only the current document's requests, and reads only their bodies", async () => {
    const fake = scripted((method, params) =>
      method === "Network.getResponseBody"
        ? params?.["requestId"] === "2.1"
          ? { body: '{"ok":true}', base64Encoded: false }
          : { body: "AAAA", base64Encoded: true }
        : undefined,
    );
    const driver = await createPageDriver(fake.cdp);
    const sent = (id: string, loaderId: string, url: string) =>
      fake.emit("Network.requestWillBeSent", {
        requestId: id,
        loaderId,
        type: "Fetch",
        request: { url, method: "GET" },
      });
    sent("1.1", "old", "http://127.0.0.1:3000/old");
    fake.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "new" } });
    sent("2.1", "new", "http://127.0.0.1:3000/api/items");
    sent("2.2", "new", "http://127.0.0.1:3000/logo.png");
    fake.emit("Network.responseReceived", {
      requestId: "2.1",
      response: { status: 200, mimeType: "application/json" },
    });
    fake.emit("Network.loadingFailed", { requestId: "2.2", errorText: "net::ERR_ABORTED" });
    expect(driver.network()).toBe(
      [
        "2.1 GET 200 Fetch application/json http://127.0.0.1:3000/api/items",
        "2.2 GET failed Fetch http://127.0.0.1:3000/logo.png (net::ERR_ABORTED)",
      ].join("\n"),
    );
    expect(driver.network("API")).toContain("2.1");
    expect(driver.network("api")).not.toContain("2.2");
    expect(await driver.responseBody("2.1")).toBe('{"ok":true}');
    expect(await driver.responseBody("2.2")).toBe("(binary, 3 bytes)");
    // A request of the document before isn't this page's to read.
    await expect(driver.responseBody("1.1")).rejects.toThrow("isn't a request of this page");
    driver.dispose();
  });

  it("evaluates in the page, saying what it threw, and captures a lossless PNG", async () => {
    let threw = false;
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x49484452, 12);
    png.writeUInt32BE(1600, 16);
    png.writeUInt32BE(1300, 20);
    const fake = scripted((method) => {
      if (method === "Runtime.evaluate")
        return threw
          ? { exceptionDetails: { exception: { description: "ReferenceError: nope" } } }
          : { result: { value: [1, 2] } };
      if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
      return undefined;
    });
    const driver = await createPageDriver(fake.cdp);
    expect(await driver.evaluate("[1, 2]")).toBe("[\n  1,\n  2\n]");
    threw = true;
    expect(await driver.evaluate("nope")).toBe("Threw: ReferenceError: nope");
    expect(of(fake.sent, "Runtime.evaluate")[0]).toMatchObject({
      expression: "[1, 2]",
      awaitPromise: true,
      returnByValue: true,
    });
    expect(await driver.screenshot({ format: "png" })).toMatchObject({ mimeType: "image/png" });
    expect(of(fake.sent, "Page.captureScreenshot")[0]).toMatchObject({ format: "png" });
    expect(driver.inspection().capture).toMatchObject({ imageWidth: 1600, imageHeight: 1300 });
    driver.dispose();
  });
});
