import { describe, expect, it } from "vitest";

import {
  actRefusal,
  agentNavigation,
  agentRequest,
  createBrowseHostList,
  isUserInput,
  isWrite,
  offLoopback,
  parsePaneRequest,
  publicPageRequest,
  submitNeedsConfirmation,
  type BrowseContext,
} from "./browse-rules.ts";

const desktop = (approved: string[] = [], once: string[] = []): BrowseContext => ({
  approved: new Set(approved),
  once: new Set(once),
});

describe("agentNavigation", () => {
  it("loads loopback freely, and approved hosts without asking", () => {
    expect(agentNavigation("http://localhost:3000/", desktop())).toEqual({
      kind: "allow",
      url: "http://localhost:3000/",
      access: "loopback",
    });
    expect(
      agentNavigation(
        "https://organization.example.invalid/a",
        desktop(["organization.example.invalid"]),
      ),
    ).toEqual({
      kind: "allow",
      url: "https://organization.example.invalid/a",
      access: "approved",
    });
    expect(
      agentNavigation(
        "https://organization.example.invalid/",
        desktop([], ["organization.example.invalid"]),
      ),
    ).toMatchObject({
      kind: "allow",
      access: "once",
    });
  });

  it("asks about a public host nobody approved, by its exact host", () => {
    expect(
      agentNavigation("https://organization.example.invalid/", desktop(["other.example.test"])),
    ).toEqual({
      kind: "ask",
      url: "https://organization.example.invalid/",
      host: "organization.example.invalid",
    });
  });

  it("refuses what no approval can let through, the approved list included", () => {
    const all = desktop(["intranet.internal", "login.microsoftonline.com"]);
    expect(agentNavigation("https://intranet.internal/", all)).toMatchObject({
      kind: "refuse",
      reason: "private",
    });
    expect(agentNavigation("https://login.microsoftonline.com/", all)).toMatchObject({
      kind: "refuse",
      reason: "signIn",
    });
    expect(agentNavigation("file:///etc/hosts", all)).toMatchObject({ reason: "scheme" });
    expect(agentNavigation("http://organization.example.invalid/", all)).toMatchObject({
      reason: "http",
    });
  });

  it("refuses the app's own loopback listeners, by origin, and nothing else on loopback", () => {
    const own: BrowseContext = {
      ...desktop(),
      appOrigins: new Set(["http://127.0.0.1:61234"]),
    };
    expect(agentNavigation("http://127.0.0.1:61234/k3y/report.html", own)).toEqual({
      kind: "refuse",
      reason: "app",
    });
    expect(agentNavigation("http://127.0.0.1:5173/", own)).toMatchObject({ kind: "allow" });
    expect(agentNavigation("http://localhost:61234/", own)).toMatchObject({ kind: "allow" });
  });

  it("refuses a page of the file preview listener on any port, so an agent neither opens nor reads one", () => {
    // By its path, so a command whose limits name no app origins still can't reach it.
    for (const url of [
      "http://127.0.0.1:52011/gram-preview-files/tok/index.html",
      "http://localhost:9/gram-preview-files/tok/data.json",
      "http://127.0.0.1:9/%67ram-preview-files/tok/",
    ]) {
      // What `browser_navigate` asks, and what every read of the page on screen checks first.
      expect(agentNavigation(url, desktop()), url).toEqual({ kind: "refuse", reason: "app" });
    }
    expect(
      agentNavigation("http://127.0.0.1:3000/docs/gram-preview-files/", desktop()),
    ).toMatchObject({ kind: "allow" });
  });
});

describe("publicPageRequest", () => {
  it("lets a public page load from public hosts and its own data", () => {
    expect(publicPageRequest("https://cdn.example.net/app.js")).toBe("allow");
    expect(publicPageRequest("wss://live.example.net/socket")).toBe("allow");
    expect(publicPageRequest("data:image/png;base64,AA==")).toBe("allow");
  });

  it("blocks loopback, private networks and sign-in pages", () => {
    for (const url of [
      "http://localhost:3000/api",
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "http://192.168.0.1/admin",
      "https://wiki.corp/",
      "https://svc.internal/",
      "https://login.microsoftonline.com/",
      "file:///etc/passwd",
      "chrome://gpu",
      "https://user:pw@organization.example.invalid/",
      "not a url",
    ]) {
      expect(publicPageRequest(url), url).toBe("block");
    }
  });
});

describe("acting", () => {
  it("holds a worker below full autonomy to loopback", () => {
    const below = { actOnLoopbackOnly: true };
    const full = { actOnLoopbackOnly: false };
    expect(actRefusal("loopback", below)).toBeUndefined();
    expect(actRefusal("approved", below)).toBe("loopbackOnly");
    expect(actRefusal("once", below)).toBe("loopbackOnly");
    expect(actRefusal("approved", full)).toBeUndefined();
  });

  it("asks before every form submission off loopback", () => {
    expect(submitNeedsConfirmation("loopback", false)).toBe(false);
    expect(submitNeedsConfirmation("approved", false)).toBe(true);
    expect(submitNeedsConfirmation("once", true)).toBe(false);
  });

  it("tells writes from reads, and loopback from everywhere else", () => {
    expect(isWrite("POST")).toBe(true);
    expect(isWrite("delete")).toBe(true);
    expect(isWrite("GET")).toBe(false);
    expect(isWrite("HEAD")).toBe(false);
    expect(offLoopback("https://organization.example.invalid")).toBe(true);
    expect(offLoopback("null")).toBe(true);
    expect(offLoopback("http://localhost:3000")).toBe(false);
    expect(offLoopback("http://127.0.0.1:5173/page")).toBe(false);
    expect(offLoopback(undefined)).toBe(false);
  });

  it("reads input after the agent's own as the user's", () => {
    expect(isUserInput(1_000, 1_200)).toBe(false);
    expect(isUserInput(1_300, 1_200)).toBe(true);
  });
});

describe("createBrowseHostList", () => {
  it("holds only hosts an agent could be approved for, and saves each change", () => {
    const saved: (readonly string[])[] = [];
    const list = createBrowseHostList({
      load: () => ["a.example.test", "login.microsoftonline.com", 7],
      save: (hosts) => saved.push(hosts),
      changed: () => {},
    });
    expect(list.hosts()).toEqual(["a.example.test"]);
    expect(list.add("b.example.test")).toBe(true);
    expect(list.add("b.example.test")).toBe(true);
    expect(list.add("login.microsoftonline.com")).toBe(false);
    expect(list.add("localhost")).toBe(false);
    list.remove("a.example.test");
    list.remove("a.example.test");
    expect(list.has("b.example.test")).toBe(true);
    expect(saved).toEqual([["a.example.test", "b.example.test"], ["b.example.test"]]);
  });
});

const request = (command: unknown, limits: unknown = { actOnLoopbackOnly: false }) => ({
  threadId: "t1",
  limits,
  command,
});

const parsed = (command: unknown) => parsePaneRequest(request(command))?.command;

describe("parsePaneRequest", () => {
  it("accepts a named key or one printable character, with known modifiers and a bounded repeat", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Escape", "Enter", "Tab", "Space", "F12", "a", "/"])
      expect(parsePaneRequest(request({ op: "pressKey", ref: "ref_1", key }))?.command).toEqual({
        op: "pressKey",
        ref: "ref_1",
        key,
      });
    // Without a ref the key goes wherever the focus is.
    expect(
      parsePaneRequest(
        request({ op: "pressKey", key: "k", modifiers: ["meta", "shift"], repeat: 3 }),
      )?.command,
    ).toEqual({ op: "pressKey", key: "k", modifiers: ["meta", "shift"], repeat: 3 });
    // A single repeat and no modifiers say nothing.
    expect(
      parsePaneRequest(request({ op: "pressKey", key: "Tab", modifiers: [], repeat: 1 }))?.command,
    ).toEqual({ op: "pressKey", key: "Tab" });
    for (const command of [
      { op: "pressKey", ref: "ref_1", key: "Ctrl+L" },
      { op: "pressKey", ref: "ref_1", key: "toString" },
      { op: "pressKey", ref: "ref_1", key: "__proto__" },
      { op: "pressKey", ref: "ref_1", key: "ab" },
      { op: "pressKey", ref: "ref_1", key: " " },
      { op: "pressKey", ref: "ref_1", key: ["ArrowDown", "Escape"] },
      { op: "pressKey", ref: "#id", key: "a" },
      { op: "pressKey", key: "a", modifiers: ["hyper"] },
      { op: "pressKey", key: "a", modifiers: ["ctrl", "ctrl"] },
      { op: "pressKey", key: "a", repeat: 0 },
      { op: "pressKey", key: "a", repeat: 101 },
      { op: "pressKey", key: "a", repeat: 1.5 },
      // Clipboard shortcuts would read or write the user's clipboard.
      { op: "pressKey", key: "v", modifiers: ["meta"] },
      { op: "pressKey", key: "V", modifiers: ["ctrl", "shift"] },
      { op: "pressKey", key: "c", modifiers: ["ctrl"] },
      { op: "pressKey", key: "x", modifiers: ["meta"] },
      { op: "pressKey", key: "Insert", modifiers: ["shift"] },
      { op: "pressKey", key: "Delete", modifiers: ["shift"] },
    ])
      expect(parsePaneRequest(request(command)), JSON.stringify(command)).toBeUndefined();
  });
  it("takes local debugging, recording and action labels in their own shapes", () => {
    expect(parsed({ op: "evaluate", expression: "document.title" })).toEqual({
      op: "evaluate",
      expression: "document.title",
    });
    // A held write it made is released by the shell's token, as every input's is.
    expect(parsed({ op: "evaluate", expression: "save()", confirmToken: "tok-12345678" })).toEqual({
      op: "evaluate",
      expression: "save()",
      confirmToken: "tok-12345678",
    });
    expect(
      parsed({ op: "click", ref: "ref_1", actionSummary: "Opens\u{E0041}\u3164 menu" }),
    ).toEqual({ op: "click", ref: "ref_1", actionSummary: "Opens menu" });
    expect(parsed({ op: "network" })).toEqual({ op: "network" });
    expect(parsed({ op: "network", requestId: "1234.56", filter: "/api" })).toEqual({
      op: "network",
      requestId: "1234.56",
      filter: "/api",
    });
    expect(parsed({ op: "recordStart", scale: 0.5 })).toEqual({ op: "recordStart", scale: 0.5 });
    expect(parsed({ op: "recordStop", discard: true })).toEqual({
      op: "recordStop",
      discard: true,
    });
    expect(parsed({ op: "screenshot", format: "png" })).toEqual({
      op: "screenshot",
      format: "png",
    });
    // A label is cleaned of what could hide or reorder text, and only labelled ops keep one.
    expect(
      parsed({ op: "click", ref: "ref_1", actionSummary: "Opens\u202e the\n  Filters menu" }),
    ).toEqual({ op: "click", ref: "ref_1", actionSummary: "Opens the Filters menu" });
    expect(parsed({ op: "snapshot", actionSummary: "x" })).toEqual({ op: "snapshot" });
    for (const command of [
      { op: "evaluate", expression: "" },
      { op: "evaluate", expression: "x".repeat(20_001) },
      { op: "network", requestId: "1; drop" },
      { op: "recordStart", scale: 2 },
      { op: "screenshot", format: "webp" },
      { op: "click", ref: "ref_1", actionSummary: "x".repeat(121) },
      { op: "click", ref: "ref_1", actionSummary: 7 },
    ])
      expect(parsed(command), JSON.stringify(command)).toBeUndefined();
  });
  it("takes the pointer, scroll, wait and read options in their own shapes", () => {
    expect(parsed({ op: "click", ref: "ref_2", button: "right", double: true })).toEqual({
      op: "click",
      ref: "ref_2",
      button: "right",
      double: true,
    });
    expect(parsed({ op: "click", ref: "ref_2", button: "left", double: false })).toEqual({
      op: "click",
      ref: "ref_2",
    });
    expect(parsed({ op: "hover", coordinate: [4, 5] })).toEqual({
      op: "hover",
      coordinate: [4, 5],
    });
    expect(parsed({ op: "scroll", direction: "down" })).toEqual({
      op: "scroll",
      direction: "down",
    });
    expect(parsed({ op: "scroll", direction: "left", amount: 10, ref: "ref_3" })).toEqual({
      op: "scroll",
      direction: "left",
      amount: 10,
      ref: "ref_3",
    });
    expect(parsed({ op: "scrollTo", ref: "ref_3" })).toEqual({ op: "scrollTo", ref: "ref_3" });
    expect(
      parsed({
        op: "drag",
        from: { ref: "ref_1" },
        to: { coordinate: [40, 50] },
        confirmToken: "tok-12345678",
      }),
    ).toEqual({
      op: "drag",
      from: { ref: "ref_1" },
      to: { coordinate: [40, 50] },
      confirmToken: "tok-12345678",
    });
    expect(parsed({ op: "wait", ms: 10_000, text: "Saved" })).toEqual({
      op: "wait",
      ms: 10_000,
      text: "Saved",
    });
    expect(
      parsed({ op: "snapshot", filter: "interactive", depth: 3, ref: "ref_9", maxChars: 500 }),
    ).toEqual({
      op: "snapshot",
      filter: "interactive",
      depth: 3,
      ref: "ref_9",
      maxChars: 500,
    });
    expect(parsed({ op: "text", maxChars: 200 })).toEqual({ op: "text", maxChars: 200 });
    expect(parsed({ op: "screenshot", scale: 0.25 })).toEqual({ op: "screenshot", scale: 0.25 });
    expect(parsed({ op: "viewport", size: { width: 375, height: 700 }, mobile: true })).toEqual({
      op: "viewport",
      size: { width: 375, height: 700 },
      mobile: true,
    });
    expect(parsed({ op: "viewport", preset: "phone", colorScheme: "dark" })).toEqual({
      op: "viewport",
      preset: "phone",
      colorScheme: "dark",
    });
    // Mobile alone keeps the size already emulated; the driver holds it below 768.
    expect(parsed({ op: "viewport", mobile: true })).toEqual({ op: "viewport", mobile: true });
    expect(parsed({ op: "viewport", colorScheme: "system" })).toEqual({
      op: "viewport",
      colorScheme: "system",
    });
    for (const command of [
      { op: "click", ref: "ref_1", button: "middle" },
      { op: "hover" },
      { op: "hover", ref: "ref_1", coordinate: [1, 1] },
      { op: "scroll", direction: "sideways" },
      { op: "scroll", direction: "up", amount: 11 },
      { op: "scroll", direction: "up", ref: "ref_1", coordinate: [1, 1] },
      { op: "scrollTo" },
      { op: "drag", from: { ref: "ref_1" } },
      { op: "drag", from: { ref: "ref_1", coordinate: [1, 1] }, to: { ref: "ref_2" } },
      { op: "wait", ms: 10_001 },
      { op: "wait", ms: 100, text: "" },
      { op: "wait", ms: 100, text: "a", ref: "ref_1" },
      { op: "snapshot", filter: "buttons" },
      { op: "snapshot", depth: 0 },
      { op: "snapshot", maxChars: 100_001 },
      { op: "text", maxChars: 10 },
      { op: "screenshot", scale: 0.05 },
      { op: "screenshot", scale: 2 },
      { op: "viewport" },
      { op: "viewport", preset: "watch" },
      { op: "viewport", preset: "phone", size: { width: 375, height: 700 } },
      { op: "viewport", size: { width: 100, height: 700 } },
      { op: "viewport", size: { width: 375.5, height: 700 } },
      { op: "viewport", colorScheme: "sepia" },
      // Mobile emulation is a phone's: below 768 wide, and never at the pane's own size.
      { op: "viewport", size: { width: 768, height: 1024 }, mobile: true },
      { op: "viewport", preset: "tablet", mobile: true },
      { op: "viewport", preset: "pane", mobile: true },
    ])
      expect(parsed(command), JSON.stringify(command)).toBeUndefined();
  });
  it("takes each command in its own shape", () => {
    expect(parsePaneRequest(request({ op: "navigate", url: "http://localhost:3000/" }))).toEqual(
      request({ op: "navigate", url: "http://localhost:3000/" }),
    );
    expect(parsePaneRequest(request({ op: "click", ref: "ref_4", extra: 1 }))?.command).toEqual({
      op: "click",
      ref: "ref_4",
    });
    expect(
      parsePaneRequest(
        request({ op: "click", coordinate: [10, 20.5], confirmToken: "tok-12345678" }),
      )?.command,
    ).toEqual({ op: "click", coordinate: [10, 20.5], confirmToken: "tok-12345678" });
    // A token is only ever the shell's own shape; a bare `true` approves nothing.
    expect(
      parsePaneRequest(
        request({ op: "type", text: "hi", submit: true, confirmed: true, confirmToken: "x y" }),
      )?.command,
    ).toEqual({ op: "type", text: "hi", submit: true });
    expect(
      parsePaneRequest(request({ op: "formInput", ref: "ref_1", value: true }))?.command,
    ).toEqual({ op: "formInput", ref: "ref_1", value: true });
    expect(
      parsePaneRequest(
        request({ op: "grant", host: "organization.example.invalid", scope: "always" }),
      ),
    ).toBeDefined();
  });

  it("refuses anything malformed", () => {
    for (const command of [
      { op: "eval", code: "1" },
      { op: "navigate" },
      { op: "click" },
      { op: "click", ref: "#submit" },
      { op: "click", coordinate: [1, Number.NaN] },
      { op: "type", text: 3 },
      { op: "formInput", ref: "ref_1", value: { x: 1 } },
      { op: "grant", host: "organization.example.invalid", scope: "forever" },
      null,
    ]) {
      expect(parsePaneRequest(request(command)), JSON.stringify(command)).toBeUndefined();
    }
    expect(parsePaneRequest({ threadId: "", limits: {}, command: { op: "text" } })).toBeUndefined();
    expect(parsePaneRequest({ threadId: "t1", command: { op: "text" } })).toBeUndefined();
  });

  it("keeps only loopback origins as the app's own", () => {
    expect(
      parsePaneRequest(
        request(
          { op: "text" },
          {
            actOnLoopbackOnly: false,
            appOrigins: [
              "http://127.0.0.1:61234",
              "http://127.0.0.1:61234/path",
              "https://organization.example.invalid",
              7,
            ],
          },
        ),
      )?.limits,
    ).toEqual({ actOnLoopbackOnly: false, appOrigins: ["http://127.0.0.1:61234"] });
  });

  it("holds a caller to loopback unless its limits say otherwise", () => {
    expect(parsePaneRequest(request({ op: "text" }, {}))?.limits).toEqual({
      actOnLoopbackOnly: true,
    });
    expect(parsePaneRequest(request({ op: "text" }, { actOnLoopbackOnly: 0 }))?.limits).toEqual({
      actOnLoopbackOnly: true,
    });
  });
});

/** A request of an agent's page on `page`: a main-frame read of an approved host by default. */
const on = (page: string, extra: Partial<Parameters<typeof agentRequest>[0]> = {}) => ({
  url: "https://organization.example.invalid/next",
  method: "GET",
  mainFrame: true,
  page,
  mayWrite: false,
  ...extra,
});

describe("agentRequest", () => {
  const approved = desktop(["organization.example.invalid"]);

  it("never lets a page or redirect elsewhere reach this computer's own services", () => {
    const local = "http://127.0.0.1:8080/admin";
    // A link or `location =` on a public page.
    expect(
      agentRequest(
        on("https://organization.example.invalid/", {
          url: local,
          initiator: "https://organization.example.invalid",
        }),
        approved,
      ),
    ).toEqual({ kind: "block", navigation: { host: "127.0.0.1:8080", reason: "fromPublic" } });
    // A public page's redirect, on a load the agent asked for.
    expect(
      agentRequest(
        on("about:blank", { url: local, before: "https://organization.example.invalid/go" }),
        approved,
      ),
    ).toMatchObject({ kind: "block", navigation: { reason: "fromPublic" } });
    // The agent's or the user's own load of a local page, and a local page's own links.
    expect(
      agentRequest(on("https://organization.example.invalid/", { url: local }), approved),
    ).toEqual({
      kind: "defer",
    });
    expect(
      agentRequest(
        on("http://localhost:3000/", { url: local, initiator: "http://localhost:3000" }),
        approved,
      ),
    ).toEqual({ kind: "defer" });
  });

  it("keeps an agent's page out of the file preview listener, but not the app's own loads", () => {
    const file = "http://127.0.0.1:52011/gram-preview-files/tok/index.html";
    const blocked = { kind: "block", navigation: { host: "127.0.0.1:52011", reason: "app" } };
    // A local page's link, and its redirect.
    const local = "http://localhost:3000/";
    expect(
      agentRequest(on(local, { url: file, initiator: "http://localhost:3000" }), approved),
    ).toEqual(blocked);
    expect(agentRequest(on(local, { url: file, before: `${local}go` }), approved)).toEqual(blocked);
    // A file card's Open, which the app loads, and the user's own click while they drive.
    expect(agentRequest(on(local, { url: file }), approved)).toEqual({ kind: "defer" });
    expect(
      agentRequest(
        on(local, { url: file, initiator: "http://127.0.0.1:52011", mayWrite: true }),
        approved,
      ),
    ).toEqual({ kind: "defer" });
  });

  it("holds a public page's writes until an approved action or the user sends them", () => {
    expect(
      agentRequest(on("https://organization.example.invalid/", { method: "POST" }), approved),
    ).toEqual({
      kind: "hold",
      host: "organization.example.invalid",
    });
    const fetch = on("https://organization.example.invalid/", {
      url: "https://api.example.net/save",
      method: "PUT",
      mainFrame: false,
    });
    // Held, and once released checked like any public request.
    expect(agentRequest(fetch, approved)).toEqual({ kind: "hold", host: "api.example.net" });
    expect(agentRequest({ ...fetch, mayWrite: true }, approved)).toEqual({
      kind: "resolve",
      host: "api.example.net",
    });
    // A form submitted by GET is held as a write is; a link with a query isn't.
    expect(
      agentRequest(
        on("https://organization.example.invalid/", {
          url: "https://organization.example.invalid/search?q=1",
          initiator: "https://organization.example.invalid",
          formSubmission: true,
        }),
        approved,
      ),
    ).toEqual({ kind: "hold", host: "organization.example.invalid" });
    expect(
      agentRequest(
        on("https://organization.example.invalid/", {
          url: "https://organization.example.invalid/search?q=1",
          initiator: "https://organization.example.invalid",
        }),
        approved,
      ),
    ).toEqual({ kind: "resolve", host: "organization.example.invalid" });
    // A form aimed at a frame in the page is held as well.
    expect(
      agentRequest(
        on("https://organization.example.invalid/", {
          url: "https://organization.example.invalid/search?q=1",
          mainFrame: false,
          initiator: "https://organization.example.invalid",
          formSubmission: true,
        }),
        approved,
      ),
    ).toEqual({ kind: "hold", host: "organization.example.invalid" });
    // On loopback the preview's own rules hold, writes included.
    expect(agentRequest({ ...fetch, page: "http://localhost:3000/" }, approved)).toEqual({
      kind: "defer",
    });
  });

  it("checks what a public page loads, and a redirect to a host not approved", () => {
    expect(agentRequest(on("about:blank"), approved)).toEqual({
      kind: "resolve",
      host: "organization.example.invalid",
    });
    expect(
      agentRequest(on("about:blank", { url: "https://other.example.org/" }), approved),
    ).toEqual({ kind: "block", navigation: { host: "other.example.org" } });
    expect(
      agentRequest(
        on("https://organization.example.invalid/", {
          url: "https://svc.internal/",
          mainFrame: false,
        }),
        approved,
      ),
    ).toEqual({ kind: "block" });
    expect(
      agentRequest(
        on("https://organization.example.invalid/", {
          url: "data:image/png;base64,AA==",
          mainFrame: false,
        }),
        approved,
      ),
    ).toEqual({ kind: "allow" });
  });
});
