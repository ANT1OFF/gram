import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { PaneCommand } from "@gram/contracts/link-trust";

import { createBrowseHostList } from "../../core/browse-rules.ts";
import { createAgentPanes } from "./pane.ts";

const LOCAL = "http://127.0.0.1:3100/";
const PUBLIC = "https://owned.example.invalid/";
// A deterministic fake CDP capture header, never presented as real-browser evidence.
const CAPTURE = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 9, 8, 0, 1, 0, 1, 0]).toString("base64");

async function fixture(
  initialUrl = LOCAL,
  actOnLoopbackOnly = true,
  decodeFrame?: (jpeg: string) => { width: number; height: number; pixels: Uint8Array },
) {
  const events = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  const sent: { method: string; params?: Record<string, unknown> | undefined }[] = [];
  const hosts = createBrowseHostList({
    load: () => ["owned.example.invalid"],
    save: () => {},
    changed: () => {},
  });
  let current = "";
  let attached = false;
  let afterDelivery: (() => void) | undefined;
  let pause: { method: string; entered: () => void; wait: Promise<void> } | undefined;
  let keyInput: (() => void) | undefined;
  let override: ((method: string, params?: Record<string, unknown>) => unknown) | undefined;
  const contents = Object.assign(events, {
    isDestroyed: () => false,
    getURL: () => current,
    getTitle: () => "Owned fixture",
    isLoading: () => false,
    loadURL: async (url: string) => {
      current = url;
      events.emit("did-navigate", {}, url);
    },
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
        sent.push({ method, params });
        if (method === "Input.dispatchKeyEvent" && params?.["type"] === "rawKeyDown") keyInput?.();
        const gate = pause?.method === method ? pause : undefined;
        if (gate !== undefined) {
          pause = undefined;
          gate.entered();
          await gate.wait;
        }
        const custom = override?.(method, params);
        if (custom !== undefined) return custom;
        switch (method) {
          case "Accessibility.getFullAXTree":
            return {
              nodes: [
                { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["button"] },
                {
                  nodeId: "button",
                  parentId: "root",
                  role: { value: "button" },
                  name: { value: "Owned button" },
                  backendDOMNodeId: 7,
                },
              ],
            };
          case "Page.getFrameTree":
            return { frameTree: { frame: { id: "owned" } } };
          case "Page.createIsolatedWorld":
            return { executionContextId: 1 };
          case "DOM.resolveNode":
            return { object: { objectId: "owned-node" } };
          case "Runtime.callFunctionOn":
            return {
              result: {
                value: /ownerDocument|activeElement/.test(String(params?.["functionDeclaration"]))
                  ? true
                  : undefined,
              },
            };
          case "DOM.getNodeForLocation":
            return { backendNodeId: 7 };
          case "DOM.getContentQuads":
            return { quads: [[10, 10, 40, 10, 40, 40, 10, 40]] };
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
          case "Page.captureScreenshot":
            return { data: CAPTURE };
          default:
            return {};
        }
      },
    }),
  });
  const panes = createAgentPanes({
    hosts,
    views: { contentsFor: () => contents as never },
    log: { warn: () => {}, info: () => {} } as never,
    resolveHost: async () => ({ endpoints: [{ address: "203.0.113.1" }] }) as never,
    driverChanged: () => afterDelivery?.(),
    decodeFrame,
  });
  const command = (input: PaneCommand, id?: string) =>
    panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly }, command: input }, id);
  expect((await command({ op: "navigate", url: initialUrl })).ok).toBe(true);
  expect((await command({ op: "snapshot" })).ok).toBe(true);
  sent.length = 0;
  return {
    panes,
    command,
    sent,
    hosts,
    onKey: (run: () => void) => {
      keyInput = run;
    },
    override: (answer: (method: string, params?: Record<string, unknown>) => unknown) => {
      override = answer;
    },
    contents,
    documentId: () => panes.inspectionOf("owned")?.documentId,
    navigate: (url: string) => {
      current = url;
      events.emit("did-navigate", {}, url);
    },
    startNavigation: (url: string) => {
      events.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
    },
    afterDelivery: (run: () => void) => {
      afterDelivery = run;
    },
    pause: (method: string) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = { method, entered, wait };
      return { started, release };
    },
  };
}

describe("command document and live authorization", () => {
  it.each([
    ["host revocation", "refused"],
    ["closure", "refused"],
    ["takeover and hand-back", "userHasControl"],
    ["cancellation", "refused"],
  ] as const)("back withholds metadata after %s while settling", async (change, code) => {
    const f = await fixture(LOCAL, false);
    Object.assign(f.contents, {
      navigationHistory: {
        canGoBack: () => true,
        goBack: () => {
          f.navigate(PUBLIC);
          if (change === "host revocation") f.hosts.remove("owned.example.invalid");
          else if (change === "closure") f.panes.closed("owned");
          else if (change === "cancellation") f.panes.cancel("back-navigation");
          else {
            f.panes.takeOver("owned");
            f.panes.handBack("owned");
          }
        },
      },
    });
    const result = await f.command({ op: "back" }, "back-navigation");
    expect(result).toMatchObject({ ok: false, code });
    expect(result.page).toBeUndefined();
    f.panes.closed("owned");
  });
  it.each([
    ["host revocation", "refused"],
    ["closure", "refused"],
    ["takeover and hand-back", "staleRef"],
    ["replacement document", "staleRef"],
    ["cancellation", "refused"],
  ] as const)("back withholds metadata after %s at delivery", async (change, code) => {
    const f = await fixture(LOCAL, false);
    Object.assign(f.contents, {
      navigationHistory: { canGoBack: () => true, goBack: () => f.navigate(PUBLIC) },
    });
    let changed = false;
    f.afterDelivery(() => {
      if (changed) return;
      changed = true;
      if (change === "host revocation") f.hosts.remove("owned.example.invalid");
      else if (change === "closure") f.panes.closed("owned");
      else if (change === "cancellation") f.panes.cancel("back-navigation");
      else if (change === "replacement document") f.navigate(`${PUBLIC}?replacement`);
      else {
        f.panes.takeOver("owned");
        f.panes.handBack("owned");
      }
    });
    const result = await f.command({ op: "back" }, "back-navigation");
    expect(result).toMatchObject({ ok: false, code });
    expect(result.page).toBeUndefined();
    f.panes.closed("owned");
  });
  it("back reports the authorized previous document", async () => {
    const f = await fixture();
    const before = f.documentId();
    Object.assign(f.contents, {
      navigationHistory: { canGoBack: () => true, goBack: () => f.navigate(`${LOCAL}?previous`) },
    });
    const result = await f.command({ op: "back" });
    expect(result).toMatchObject({
      ok: true,
      page: { url: `${LOCAL}?previous`, access: "loopback", driver: "agent" },
    });
    expect(f.documentId()).not.toBe(before);
    f.panes.closed("owned");
  });
  it("back without history refuses without dispatching navigation", async () => {
    const f = await fixture();
    let navigated = false;
    Object.assign(f.contents, {
      navigationHistory: {
        canGoBack: () => false,
        goBack: () => {
          navigated = true;
        },
      },
    });
    expect(await f.command({ op: "back" })).toMatchObject({ ok: false, code: "failed" });
    expect(navigated).toBe(false);
    expect(f.contents.getURL()).toBe(LOCAL);
    f.panes.closed("owned");
  });
  it.each([
    ["host revocation", "refused"],
    ["closure", "refused"],
    ["takeover and hand-back", "userHasControl"],
    ["cancellation", "refused"],
  ] as const)("withholds navigation metadata after %s during loading", async (change, code) => {
    const f = await fixture(PUBLIC, false);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = f.contents.loadURL;
    f.contents.loadURL = async (url) => {
      await load(url);
      entered();
      await wait;
    };
    const navigation = f.command(
      { op: "navigate", url: `${PUBLIC}?loading` },
      "loading-navigation",
    );
    await started;
    if (change === "host revocation") f.hosts.remove("owned.example.invalid");
    else if (change === "closure") f.panes.closed("owned");
    else if (change === "cancellation") f.panes.cancel("loading-navigation");
    else {
      f.panes.takeOver("owned");
      f.panes.handBack("owned");
    }
    release();
    const result = await navigation;
    expect(result).toMatchObject({ ok: false, code });
    expect(result.page).toBeUndefined();
    if (change !== "takeover and hand-back") expect(result.inspection).toBeUndefined();
    f.panes.closed("owned");
  });
  it.each([
    ["host revocation", "refused"],
    ["closure", "refused"],
    ["takeover and hand-back", "staleRef"],
    ["replacement document", "staleRef"],
  ] as const)(
    "withholds completed navigation metadata after %s at delivery",
    async (change, code) => {
      const f = await fixture(PUBLIC, false);
      let changed = false;
      f.afterDelivery(() => {
        if (changed) return;
        changed = true;
        if (change === "host revocation") f.hosts.remove("owned.example.invalid");
        else if (change === "closure") f.panes.closed("owned");
        else if (change === "replacement document") f.navigate(`${PUBLIC}?replacement`);
        else {
          f.panes.takeOver("owned");
          f.panes.handBack("owned");
        }
      });
      const result = await f.command({ op: "navigate", url: `${PUBLIC}?intended` });
      expect(result).toMatchObject({ ok: false, code });
      expect(result.page).toBeUndefined();
      f.panes.closed("owned");
    },
  );
  it.each([
    ["takeover and hand-back", "userHasControl"],
    ["cancellation", "refused"],
    ["closure", "staleRef"],
    ["host revocation", "needsApproval"],
  ] as const)("queued navigation stops after %s", async (change, code) => {
    const f = await fixture();
    const gate = f.pause("Page.captureScreenshot");
    const reading = f.command({ op: "screenshot" });
    await gate.started;
    const navigation = f.command(
      { op: "navigate", url: change === "host revocation" ? PUBLIC : `${LOCAL}?revived` },
      "queued-navigation",
    );
    if (change === "takeover and hand-back") {
      f.panes.takeOver("owned");
      f.panes.handBack("owned");
    } else if (change === "cancellation") f.panes.cancel("queued-navigation");
    else if (change === "closure") f.panes.closed("owned");
    else f.hosts.remove("owned.example.invalid");
    gate.release();
    await reading;
    expect(await navigation).toMatchObject({ ok: false, code });
    expect(f.contents.getURL()).toBe(LOCAL);
    f.panes.closed("owned");
  });
  it("queued navigation may replace a changed document under unchanged ownership", async () => {
    const f = await fixture();
    const gate = f.pause("Page.captureScreenshot");
    const reading = f.command({ op: "screenshot" });
    await gate.started;
    const navigation = f.command({ op: "navigate", url: `${LOCAL}?intended` });
    f.navigate(`${LOCAL}?predecessor`);
    gate.release();
    await reading;
    expect(await navigation).toMatchObject({ ok: true, page: { url: `${LOCAL}?intended` } });
    expect(f.contents.getURL()).toBe(`${LOCAL}?intended`);
    f.panes.closed("owned");
  });
  it("queued host consent retains grant semantics after takeover and hand-back", async () => {
    const f = await fixture();
    const gate = f.pause("Page.captureScreenshot");
    const reading = f.command({ op: "screenshot" });
    await gate.started;
    const grant = f.command({ op: "grant", host: "consent.example.invalid", scope: "always" });
    f.panes.takeOver("owned");
    f.panes.handBack("owned");
    gate.release();
    await reading;
    expect(await grant).toMatchObject({ ok: true, page: null });
    expect(f.hosts.hosts()).toContain("consent.example.invalid");
    f.panes.closed("owned");
  });
  it.each(["host revocation", "closure"])(
    "stops pending keys after %s without stale output",
    async (kind) => {
      const f = await fixture(PUBLIC, false);
      const gate = f.pause("DOM.focus");
      const key = f.command({ op: "pressKey", ref: "ref_1", key: "ArrowDown" });
      await gate.started;
      if (kind === "closure") f.panes.closed("owned");
      else f.hosts.remove("owned.example.invalid");
      gate.release();
      const result = await key;
      expect(result).toMatchObject({ ok: false, code: "refused" });
      expect(result.inspection).toBeUndefined();
      expect("content" in result || "image" in result).toBe(false);
      expect(f.sent.filter(({ method }) => method.startsWith("Input."))).toEqual([]);
      f.panes.closed("owned");
    },
  );
  it("holds public writes triggered by a navigation key and releases once without replay", async () => {
    const f = await fixture(PUBLIC, false);
    let write!: Promise<"allow" | "block">;
    f.onKey(() => {
      write = f.panes.request(
        f.contents as never,
        {
          id: "owned-write",
          url: `${PUBLIC}save`,
          method: "POST",
          mainFrame: false,
        } as never,
      )!;
    });
    const held = await f.command({ op: "pressKey", ref: "ref_1", key: "ArrowDown" });
    expect(held).toMatchObject({ ok: false, code: "needsConfirmation" });
    if (held.ok || held.confirm === undefined) throw new Error("Expected a held public write");
    expect(f.sent.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(2);
    expect(
      await f.command({
        op: "pressKey",
        ref: "ref_1",
        key: "ArrowDown",
        confirmToken: held.confirm.token,
      }),
    ).toMatchObject({ ok: true });
    expect(await write).toBe("allow");
    expect(f.sent.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(2);
    f.panes.closed("owned");
  });
  it("cancelled queued key input never runs after its predecessor completes", async () => {
    const f = await fixture();
    const gate = f.pause("Page.captureScreenshot");
    const reading = f.command({ op: "screenshot" });
    await gate.started;
    const key = f.command({ op: "pressKey", ref: "ref_1", key: "ArrowDown" }, "queued-key");
    f.panes.cancel("queued-key");
    gate.release();
    await reading;
    expect(await key).toMatchObject({ ok: false, code: "refused" });
    expect(
      f.sent.filter(({ method }) => method.startsWith("Input.") || method === "DOM.focus"),
    ).toEqual([]);
    f.panes.closed("owned");
  });

  it("cancellation during focus stops key dispatch and withholds output", async () => {
    const f = await fixture();
    const gate = f.pause("DOM.focus");
    const key = f.command({ op: "pressKey", ref: "ref_1", key: "Escape" }, "executing-key");
    await gate.started;
    f.panes.cancel("executing-key");
    gate.release();
    expect(await key).toMatchObject({ ok: false, code: "refused" });
    expect(f.sent.filter(({ method }) => method.startsWith("Input."))).toEqual([]);
    f.panes.closed("owned");
  });

  it("takeover then hand-back invalidates queued keys instead of reviving ownership", async () => {
    const f = await fixture();
    const gate = f.pause("Page.captureScreenshot");
    const reading = f.command({ op: "screenshot" });
    await gate.started;
    const key = f.command({ op: "pressKey", ref: "ref_1", key: "ArrowDown" });
    f.panes.takeOver("owned");
    f.panes.handBack("owned");
    gate.release();
    await reading;
    expect(await key).toMatchObject({ ok: false, code: "userHasControl" });
    expect(
      f.sent.filter(({ method }) => method.startsWith("Input.") || method === "DOM.focus"),
    ).toEqual([]);
    f.panes.closed("owned");
  });

  it("key input respects public-site action limits and fresh refs", async () => {
    const f = await fixture(PUBLIC);
    expect(await f.command({ op: "pressKey", ref: "ref_1", key: "ArrowDown" })).toMatchObject({
      ok: false,
      code: "loopbackOnly",
    });
    expect(
      f.sent.filter(({ method }) => method.startsWith("Input.") || method === "DOM.focus"),
    ).toEqual([]);
    f.navigate(LOCAL);
    expect(await f.command({ op: "pressKey", ref: "ref_1", key: "ArrowDown" })).toMatchObject({
      ok: false,
      code: "staleRef",
    });
    expect(
      f.sent.filter(({ method }) => method.startsWith("Input.") || method === "DOM.focus"),
    ).toEqual([]);
    f.panes.closed("owned");
  });
  it("rejects queued coordinate input admitted on a replaced document", async () => {
    const f = await fixture();
    const gate = f.pause("Page.captureScreenshot");
    const reading = f.command({ op: "screenshot" });
    await gate.started;
    const queued = f.command({ op: "click", coordinate: [20, 20] });
    f.navigate(`${LOCAL}?replacement`);
    gate.release();
    await reading;
    expect(await queued).toMatchObject({ ok: false, code: "staleRef" });
    expect(f.sent.filter(({ method }) => method.startsWith("Input."))).toEqual([]);
    f.panes.closed("owned");
  });
  it.each([
    ["different local document", `${LOCAL}?next`, "staleRef"],
    ["approved public document at loopback-only autonomy", PUBLIC, "staleRef"],
    ["private page", "http://192.168.1.1/", "refused"],
    ["sign-in page", "https://login.microsoftonline.com/", "refused"],
    ["file preview", `${LOCAL}gram-preview-files/owned/index.html`, "refused"],
  ])("stops a click after submission lookup reaches a %s", async (_name, next, code) => {
    const f = await fixture();
    const gate = f.pause("Runtime.callFunctionOn");
    const result = f.command({ op: "click", ref: "ref_1" });
    await gate.started;
    f.navigate(next);
    gate.release();
    expect(await result).toMatchObject({ ok: false, code });
    expect(
      f.sent.some(
        ({ method }) => method.startsWith("Input.") || method === "DOM.scrollIntoViewIfNeeded",
      ),
    ).toBe(false);
    f.panes.closed("owned");
  });

  it("stops a command when main-frame navigation starts before URL commit", async () => {
    const f = await fixture();
    const gate = f.pause("Runtime.callFunctionOn");
    const result = f.command({ op: "type", ref: "ref_1", text: "owned input", submit: true });
    await gate.started;
    f.startNavigation(`${LOCAL}?next`);
    gate.release();
    expect(await result).toMatchObject({ ok: false, code: "staleRef" });
    expect(f.sent.some(({ method }) => method.startsWith("Input.") || method === "DOM.focus")).toBe(
      false,
    );
    f.panes.closed("owned");
  });

  it("stops typing after focus navigates, retaining the original document evidence", async () => {
    const f = await fixture();
    const original = f.documentId();
    const gate = f.pause("DOM.focus");
    const result = f.command({ op: "type", ref: "ref_1", text: "owned input" });
    await gate.started;
    f.navigate(LOCAL); // Same URL, different document: URL equality alone is insufficient.
    gate.release();
    expect(await result).toMatchObject({
      ok: false,
      code: "staleRef",
      inspection: {
        action: { documentId: original, status: "dispatch-unknown", failure: "dispatch-error" },
      },
    });
    expect(f.documentId()).not.toBe(original);
    expect(f.sent.some(({ method }) => method === "Input.insertText")).toBe(false);
    f.panes.closed("owned");
  });

  it("stops later mouse dispatch after host approval is revoked", async () => {
    const f = await fixture(PUBLIC, false);
    const gate = f.pause("Input.dispatchMouseEvent");
    const result = f.command({ op: "click", coordinate: [20, 20] });
    await gate.started;
    f.hosts.remove("owned.example.invalid");
    gate.release();
    expect(await result).toMatchObject({ ok: false, code: "refused" });
    expect((await result).inspection).toBeUndefined();
    expect(
      f.sent
        .filter(({ method }) => method === "Input.dispatchMouseEvent")
        .map(({ params }) => params?.["type"]),
    ).toEqual(["mouseMoved"]);
    f.panes.closed("owned");
  });

  it("refuses form mutation after node resolution loses host approval", async () => {
    const f = await fixture(PUBLIC, false);
    const gate = f.pause("DOM.resolveNode");
    const result = f.command({ op: "formInput", ref: "ref_1", value: "owned input" });
    await gate.started;
    f.hosts.remove("owned.example.invalid");
    gate.release();
    expect(await result).toMatchObject({ ok: false, code: "refused" });
    expect(f.sent.some(({ method }) => method === "Runtime.callFunctionOn")).toBe(false);
    f.panes.closed("owned");
  });

  it.each(["Page.getLayoutMetrics", "Page.captureScreenshot"])(
    "withholds agent capture after approval revocation during %s",
    async (method) => {
      const f = await fixture(PUBLIC, false);
      const gate = f.pause(method);
      const result = f.command({ op: "screenshot" });
      await gate.started;
      f.hosts.remove("owned.example.invalid");
      gate.release();
      const withheld = await result;
      expect(withheld).toMatchObject({ ok: false, code: "refused" });
      expect("image" in withheld).toBe(false);
      expect(withheld.inspection).toBeUndefined();
      if (method === "Page.getLayoutMetrics")
        expect(f.sent.some((entry) => entry.method === "Page.captureScreenshot")).toBe(false);
      f.panes.closed("owned");
    },
  );

  it("withholds completed capture when approval is revoked in final delivery notification", async () => {
    const f = await fixture(PUBLIC, false);
    f.afterDelivery(() => f.hosts.remove("owned.example.invalid"));
    const result = await f.command({ op: "screenshot" });
    expect(result).toMatchObject({ ok: false, code: "refused" });
    expect("image" in result).toBe(false);
    expect(result.inspection).toBeUndefined();
    f.panes.closed("owned");
  });

  it("withholds a submission confirmation if its document changes at delivery", async () => {
    const f = await fixture(PUBLIC, false);
    f.afterDelivery(() => f.navigate(LOCAL));
    const result = await f.command({ op: "type", ref: "ref_1", text: "owned input", submit: true });
    expect(result).toMatchObject({ ok: false, code: "staleRef" });
    expect("confirm" in result).toBe(false);
    expect(f.sent.some(({ method }) => method.startsWith("Input.") || method === "DOM.focus")).toBe(
      false,
    );
    f.panes.closed("owned");
  });

  it("withholds completed capture if the document changes at delivery", async () => {
    const f = await fixture();
    f.afterDelivery(() => f.navigate(LOCAL));
    const result = await f.command({ op: "screenshot" });
    expect(result).toMatchObject({ ok: false, code: "staleRef" });
    expect("image" in result).toBe(false);
    f.panes.closed("owned");
  });

  it("UI capture also withholds bytes after live approval revocation", async () => {
    const f = await fixture(PUBLIC, false);
    const gate = f.pause("Page.captureScreenshot");
    const result = f.panes.inspect("owned");
    await gate.started;
    f.hosts.remove("owned.example.invalid");
    gate.release();
    const withheld = await result;
    expect(withheld.ok).toBe(false);
    expect("image" in withheld).toBe(false);
    expect(withheld.inspection).toBeUndefined();
    f.panes.closed("owned");
  });

  it("withholds page text after approval revocation during a read", async () => {
    const f = await fixture(PUBLIC, false);
    const gate = f.pause("Runtime.callFunctionOn");
    const result = f.command({ op: "text" });
    await gate.started;
    f.hosts.remove("owned.example.invalid");
    gate.release();
    const withheld = await result;
    expect(withheld).toMatchObject({ ok: false, code: "refused" });
    expect("content" in withheld).toBe(false);
    f.panes.closed("owned");
  });
});

const input = (sent: { method: string }[]) =>
  sent.filter(({ method }) => method.startsWith("Input.") || method === "DOM.focus");
/** Answers the isolated world's submission questions as a form's submit control would. */
const submitControl = (method: string, params?: Record<string, unknown>) =>
  method === "Runtime.callFunctionOn" &&
  /closest\("button, input\[type=submit\]/.test(String(params?.["functionDeclaration"]))
    ? { result: { value: { action: `${PUBLIC}pay`, control: "Pay" } } }
    : undefined;

describe("pointer, key, wait and viewport commands", () => {
  it("asks before Enter on a public page, and never repeats a key that may submit", async () => {
    const f = await fixture(PUBLIC, false);
    const asked = await f.command({ op: "pressKey", key: "Enter" });
    expect(asked).toMatchObject({
      ok: false,
      code: "needsConfirmation",
      confirm: { control: "Enter" },
    });
    expect(
      await f.command({ op: "pressKey", ref: "ref_1", key: "Enter", repeat: 3 }),
    ).toMatchObject({ ok: false, code: "failed" });
    f.override(submitControl);
    expect(await f.command({ op: "pressKey", ref: "ref_1", key: "Space" })).toMatchObject({
      ok: false,
      code: "needsConfirmation",
      confirm: { action: `${PUBLIC}pay`, control: "Pay" },
    });
    expect(input(f.sent)).toEqual([]);
    // Other keys, shortcuts included, go straight through; their writes are still held.
    expect(
      await f.command({ op: "pressKey", key: "k", modifiers: ["meta"], repeat: 2 }),
    ).toMatchObject({ ok: true });
    expect(f.sent.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(4);
    f.panes.closed("owned");
  });

  it("runs an approved Enter once, for the submission its card named", async () => {
    const f = await fixture(PUBLIC, false);
    const asked = await f.command({ op: "pressKey", ref: "ref_1", key: "Enter" });
    if (asked.ok || asked.confirm === undefined) throw new Error("Expected a confirmation");
    expect(
      await f.command({
        op: "pressKey",
        ref: "ref_1",
        key: "Enter",
        confirmToken: asked.confirm.token,
      }),
    ).toMatchObject({ ok: true });
    expect(f.sent.filter(({ method }) => method === "Input.dispatchKeyEvent")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ type: "keyDown", key: "Enter" }),
      }),
      expect.objectContaining({ params: expect.objectContaining({ type: "keyUp" }) }),
    ]);
    f.panes.closed("owned");
  });

  it("refuses a double click that would submit a public form twice, and a right click asks nothing", async () => {
    const f = await fixture(PUBLIC, false);
    f.override(submitControl);
    expect(await f.command({ op: "click", ref: "ref_1", double: true })).toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(input(f.sent)).toEqual([]);
    expect(await f.command({ op: "click", ref: "ref_1", button: "right" })).toMatchObject({
      ok: true,
    });
    expect(
      f.sent
        .filter(({ method }) => method === "Input.dispatchMouseEvent")
        .map(({ params }) => params?.["button"]),
    ).toEqual([undefined, "right", "right"]);
    f.panes.closed("owned");
  });

  it.each([
    { op: "hover", ref: "ref_1" },
    { op: "scroll", direction: "down" },
    { op: "scrollTo", ref: "ref_1" },
    { op: "drag", from: { ref: "ref_1" }, to: { coordinate: [100, 100] } },
    { op: "pressKey", key: "Tab" },
  ] as const)("$op keeps the public-site action limit and the user's control", async (command) => {
    const limited = await fixture(PUBLIC);
    expect(await limited.command(command)).toMatchObject({ ok: false, code: "loopbackOnly" });
    expect(input(limited.sent)).toEqual([]);
    limited.panes.closed("owned");
    const local = await fixture(LOCAL);
    local.panes.takeOver("owned");
    expect(await local.command(command)).toMatchObject({ ok: false, code: "userHasControl" });
    expect(input(local.sent)).toEqual([]);
    local.panes.handBack("owned");
    expect(await local.command(command)).toMatchObject({ ok: true });
    local.panes.closed("owned");
  });

  it("holds a public write a scroll set off, and releases it without scrolling again", async () => {
    const f = await fixture(PUBLIC, false);
    let write!: Promise<"allow" | "block">;
    f.override((method, params) => {
      if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mouseWheel")
        write = f.panes.request(
          f.contents as never,
          {
            id: "owned-scroll-write",
            url: `${PUBLIC}track`,
            method: "POST",
            mainFrame: false,
          } as never,
        )!;
      return undefined;
    });
    const held = await f.command({ op: "scroll", direction: "down", amount: 2 });
    if (held.ok || held.confirm === undefined) throw new Error("Expected a held write");
    expect(
      await f.command({
        op: "scroll",
        direction: "down",
        amount: 2,
        confirmToken: held.confirm.token,
      }),
    ).toMatchObject({ ok: true });
    expect(await write).toBe("allow");
    expect(
      f.sent.filter(
        ({ method, params }) =>
          method === "Input.dispatchMouseEvent" && params?.["type"] === "mouseWheel",
      ),
    ).toHaveLength(1);
    f.panes.closed("owned");
  });

  it("waits for text on the page as a read, and reads what the snapshot options ask", async () => {
    const f = await fixture(PUBLIC);
    f.override((method, params) =>
      method === "Runtime.callFunctionOn" &&
      String(params?.["functionDeclaration"]).includes("innerText")
        ? { result: { value: "Ready" } }
        : undefined,
    );
    // A worker held to loopback still reads an approved public page.
    expect(await f.command({ op: "wait", ms: 1_000, text: "ready" })).toMatchObject({
      ok: true,
      content: "shown",
    });
    expect(await f.command({ op: "snapshot", filter: "interactive", maxChars: 200 })).toMatchObject(
      {
        ok: true,
        content: '- button "Owned button" [ref_1]',
      },
    );
    f.panes.takeOver("owned");
    expect(await f.command({ op: "wait", ms: 0, text: "ready" })).toMatchObject({ ok: true });
    f.panes.closed("owned");
  });

  it("emulates a phone and a dark scheme on a local page, behind the same ownership", async () => {
    const f = await fixture(LOCAL);
    const result = await f.command({
      op: "viewport",
      size: { width: 375, height: 700 },
      mobile: true,
      colorScheme: "dark",
    });
    expect(result).toMatchObject({
      ok: true,
      inspection: { emulation: { width: 375, height: 700, mobile: true, colorScheme: "dark" } },
    });
    f.panes.takeOver("owned");
    expect(await f.command({ op: "viewport", preset: "pane" })).toMatchObject({
      ok: false,
      code: "userHasControl",
    });
    f.panes.closed("owned");
  });
});

describe("local-only debugging, recording and labels", () => {
  it("runs code and reads requests on a local page, and refuses both on a public one", async () => {
    const local = await fixture(LOCAL);
    local.override((method) =>
      method === "Runtime.evaluate" ? { result: { value: { count: 3 } } } : undefined,
    );
    expect(await local.command({ op: "evaluate", expression: "state" })).toMatchObject({
      ok: true,
      content: '{\n  "count": 3\n}',
    });
    expect(await local.command({ op: "network" })).toMatchObject({ ok: true });
    local.panes.closed("owned");
    const pub = await fixture(PUBLIC, false);
    for (const command of [
      { op: "evaluate", expression: "document.cookie" },
      { op: "network" },
      { op: "network", requestId: "1.1" },
    ] as const)
      expect(await pub.command(command)).toMatchObject({ ok: false, code: "refused" });
    expect(
      pub.sent.filter(
        ({ method }) => method === "Runtime.evaluate" || method === "Network.getResponseBody",
      ),
    ).toEqual([]);
    pub.panes.closed("owned");
  });

  it("refuses a blank page and a document whose origin isn't local", async () => {
    const blank = await fixture("about:blank");
    for (const command of [
      { op: "evaluate", expression: "document.cookie" },
      { op: "network" },
    ] as const)
      expect(await blank.command(command)).toMatchObject({ ok: false, code: "refused" });
    blank.panes.closed("owned");
    // A loopback address whose document carries a public origin, as a page it came from lends.
    const lent = await fixture(LOCAL);
    lent.override((method) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "owned", securityOrigin: "https://owned.example.invalid" } } }
        : undefined,
    );
    expect(await lent.command({ op: "evaluate", expression: "document.cookie" })).toMatchObject({
      ok: false,
      code: "refused",
    });
    expect(lent.sent.filter(({ method }) => method === "Runtime.evaluate")).toEqual([]);
    lent.panes.closed("owned");
  });

  it("evaluates only while the agent drives", async () => {
    const f = await fixture(LOCAL);
    f.panes.takeOver("owned");
    expect(await f.command({ op: "evaluate", expression: "1" })).toMatchObject({
      ok: false,
      code: "userHasControl",
    });
    expect(f.sent.filter(({ method }) => method === "Runtime.evaluate")).toEqual([]);
    f.panes.closed("owned");
  });

  it("records frames into a GIF, merging unchanged ones, and needs a decoder to start", async () => {
    let shade = 0;
    const decode = () => ({
      width: 2,
      height: 1,
      pixels: Uint8Array.from([shade, shade, shade, 255, shade, shade, shade, 255]),
    });
    const f = await fixture(LOCAL, true, decode);
    expect(f.panes.recordingOf("owned")).toBe(false);
    expect(await f.command({ op: "recordStart", scale: 0.25 })).toMatchObject({ ok: true });
    expect(f.panes.recordingOf("owned")).toBe(true);
    expect(await f.command({ op: "recordStart" })).toMatchObject({ ok: false, code: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    shade = 200;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stopped = await f.command({ op: "recordStop" });
    expect(stopped).toMatchObject({ ok: true, file: { mimeType: "image/gif" } });
    if (!stopped.ok || stopped.file === undefined) throw new Error("Expected a GIF");
    expect(Buffer.from(stopped.file.data, "base64").subarray(0, 6).toString()).toBe("GIF89a");
    expect(stopped.content).toMatch(/^2 frames over/);
    expect(
      f.sent
        .filter(({ method }) => method === "Page.captureScreenshot")
        .every(
          ({ params }) => (params?.["clip"] as { scale?: number } | undefined)?.scale === 0.25,
        ),
    ).toBe(true);
    expect(f.panes.recordingOf("owned")).toBe(false);
    expect(await f.command({ op: "recordStop" })).toMatchObject({ ok: false, code: "failed" });
    f.panes.closed("owned");
    const plain = await fixture(LOCAL);
    expect(await plain.command({ op: "recordStart" })).toMatchObject({
      ok: false,
      code: "refused",
    });
    plain.panes.closed("owned");
  });

  it("captures a lossless PNG when asked, for evidence", async () => {
    const f = await fixture(LOCAL);
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x49484452, 12);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(650, 20);
    f.override((method) =>
      method === "Page.captureScreenshot" ? { data: png.toString("base64") } : undefined,
    );
    expect(await f.command({ op: "screenshot", format: "png" })).toMatchObject({
      ok: true,
      image: { mimeType: "image/png" },
      inspection: { capture: { imageWidth: 800, imageHeight: 650 } },
    });
    expect(f.sent.find(({ method }) => method === "Page.captureScreenshot")?.params).toMatchObject({
      format: "png",
    });
    f.panes.closed("owned");
  });

  it("takes no frames while the user drives the page", async () => {
    const f = await fixture(LOCAL, true, () => ({
      width: 1,
      height: 1,
      pixels: Uint8Array.from([Math.random() * 255, 0, 0, 255]),
    }));
    expect(await f.command({ op: "recordStart" })).toMatchObject({ ok: true });
    f.panes.takeOver("owned");
    f.sent.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.sent.filter(({ method }) => method === "Page.captureScreenshot")).toEqual([]);
    expect(f.panes.recordingOf("owned")).toBe(true);
    f.panes.closed("owned");
  });

  it("keeps the latest action label for the pane's header", async () => {
    const f = await fixture(LOCAL);
    expect(f.panes.actionOf("owned")).toBeUndefined();
    await f.command({ op: "click", ref: "ref_1", actionSummary: "Opens the Filters menu" });
    expect(f.panes.actionOf("owned")).toMatchObject({ summary: "Opens the Filters menu" });
    f.panes.closed("owned");
  });
});
