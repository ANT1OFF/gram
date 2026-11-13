// Disposable native fixture for pinned pages. No Gram store, installed app, provider CLI, personal
// browser or outside network. A synthetic worktree's page is pinned with the server's own pages
// store, served by the server's own listener code with its headers, and opened through the shell's
// own pages module in the real `gram-pages` session. Chromium's resolver maps every `.example` name
// to loopback, so a request that went out by name would reach a listener here and be counted.
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  session,
  WebContentsView,
  webContents as allContents,
} from "electron";
import * as Effect from "effect/Effect";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PAGES_PARTITION, PAGES_SEGMENT } from "../../../../packages/contracts/src/page-url.ts";
import { Channels } from "../../../../packages/shell/src/channels.ts";
import { installPages } from "../../../../packages/shell/src/modules/pages/main.ts";
import { installPreview } from "../../../../packages/shell/src/modules/preview/main.ts";
import { pageHeaders } from "../../../../packages/server/src/pages/page-files.ts";
import { makePages } from "../../../../packages/server/src/pages/pages.ts";
import {
  emptyPreviewFolders,
  grantFolder,
  handleFileRequest,
} from "../../../../packages/server/src/preview/files.ts";

const results = [];
const failures = [];
const check = (label, ok, detail) => {
  (ok ? results : failures).push(
    detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`,
  );
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A listener on loopback that records what reached it. */
async function listener(respond = (_request, response) => response.writeHead(200).end("{}")) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    respond(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: server.address().port, server };
}

/** A UDP and a TCP listener on loopback, counting what reaches them: STUN, TURN, a preconnect. */
async function rawListeners() {
  const udp = createSocket("udp4");
  const packets = [];
  udp.on("message", (message) => packets.push(message.length));
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const connections = [];
  const tcp = createTcpServer((socket) => {
    connections.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  return {
    packets,
    connections,
    udpPort: udp.address().port,
    tcpPort: tcp.address().port,
    close: () => {
      udp.close();
      tcp.close();
    },
  };
}

/** The probe page: every exit it tries, titled into `probe:<json>` once they settle. */
const probePage = ({ G, other, raw, preconnect }) => `<!doctype html>
<html><head><title>Board v1</title>
<meta charset="utf-8">
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="http://127.0.0.1:${G}/style-elsewhere.css">
<link rel="preconnect" href="http://preconnect.example:${preconnect.tcpPort}">
<link rel="dns-prefetch" href="//prefetch.example">
<script src="app.js"></script>
<script type="module" src="module.js"></script>
<script src="http://127.0.0.1:${G}/script-elsewhere.js"></script>
<script src="${other}"></script>
</head><body>
<p id="styled">Pinned</p>
<img id="own" src="dot.svg">
<img src="http://127.0.0.1:${G}/img-elsewhere.png">
<img src="http://site.example:${G}/img-by-name.png">
<a id="own-link" href="second.html">Second</a>
<form id="form" action="http://127.0.0.1:${G}/form" method="post"><input name="x" value="1"></form>
<script>
const results = {};
const settle = (promise, ms = 3000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))]);
const probe = (name, url, init = {}) =>
  settle(
    fetch(url, { mode: "no-cors", ...init }).then(
      () => (results[name] = "reached"),
      () => (results[name] = "blocked"),
    ),
  ).then((r) => (r === "timeout" ? (results[name] = "timeout") : r));
(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  results.ran = typeof window.appRan === "string" ? window.appRan : "no";
  results.module = typeof window.moduleRan === "string" ? window.moduleRan : "no";
  results.styled = getComputedStyle(document.getElementById("styled")).color;
  results.ownImage = document.getElementById("own").naturalWidth > 0 ? "loaded" : "missing";
  results.origin = self.origin;
  await probe("ownFile", "app.js");
  await probe("gramGet", "http://127.0.0.1:${G}/api/threads");
  await probe("gramPost", "http://127.0.0.1:${G}/api/threads", { method: "POST", body: "x" });
  await probe("byName", "http://site.example:${G}/by-name");
  await probe("otherPage", "${other}");
  await probe("internet", "https://example.com/");
  results.socket = await settle(new Promise((resolve) => {
    try {
      const socket = new WebSocket("ws://127.0.0.1:${G}/ws");
      socket.onopen = () => resolve("reached");
      socket.onerror = () => resolve("blocked");
    } catch (error) { resolve("threw"); }
  }));
  results.beacon = String(navigator.sendBeacon?.("http://127.0.0.1:${G}/beacon", "x"));
  results.eventSource = await settle(new Promise((resolve) => {
    try {
      const source = new EventSource("http://127.0.0.1:${G}/events");
      source.onopen = () => resolve("reached");
      source.onerror = () => resolve("blocked");
    } catch (error) { resolve("threw"); }
  }));
  results.rtc = await settle((async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [
        { urls: "stun:127.0.0.1:${raw.udpPort}" },
        { urls: "turn:127.0.0.1:${raw.tcpPort}?transport=tcp", username: "x", credential: "x" },
      ] });
      pc.createDataChannel("probe");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return "gathered";
    } catch (error) { return "threw:" + error.name; }
  })(), 4000);
  results.bridge = [typeof window.gram, typeof process, typeof require, typeof ipcRenderer].join(",");
  try { localStorage.setItem("k", "v"); results.storage = "usable"; } catch (error) { results.storage = "refused"; }
  try { document.cookie = "a=b"; results.cookie = "set:" + document.cookie; } catch (error) { results.cookie = "refused"; }
  try { results.indexedDB = typeof indexedDB.open("x"); } catch (error) { results.indexedDB = "refused"; }
  try { const opened = window.open("http://127.0.0.1:${G}/popup"); results.popup = opened === null ? "denied" : "opened"; } catch (error) { results.popup = "threw"; }
  results.notification = await settle(Notification.requestPermission());
  document.title = "probe:" + JSON.stringify(results);
  // Last, and only where the sandbox header is served: a page with modals allowed would wait here
  // on the dialog.
  if (location.hash !== "#no-dialog") {
    try { alert("x"); results.alert = "returned"; } catch (error) { results.alert = "threw"; }
  }
  document.title = "probe:" + JSON.stringify(results);
  // Last of all, since where it may, it navigates the page away.
  setTimeout(() => document.getElementById("form").submit(), 1500);
})();
</script></body></html>`;

/**
 * The clipboard and download page: a button whose click copies by `execCommand` and the async
 * clipboard, a copy handler that would put its own text in, and a link that downloads.
 */
const clipPage = `<!doctype html><title>Clip</title>
<p id="text">Copy me</p>
<button id="copy" style="position:fixed;left:10px;top:40px;width:200px;height:60px">Copy</button>
<a id="dl" download="x.txt" href="data:text/plain,leak" style="position:fixed;left:10px;top:120px;width:200px;height:60px;display:block">Download</a>
<script>
window.clip = {};
document.getElementById("copy").addEventListener("click", () => {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("text"));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  try { clip.execCopy = String(document.execCommand("copy")); } catch (error) { clip.execCopy = "threw"; }
  navigator.clipboard?.writeText("leak-async").then(
    () => (clip.asyncCopy = "written"),
    (error) => (clip.asyncCopy = "refused:" + error.name),
  );
});
document.addEventListener("copy", (event) => {
  clip.copyEvent = "fired";
  event.clipboardData?.setData("text/plain", "leak-copy-event");
  event.preventDefault();
});
// Whose execCommand each frame has: the guard's, or the browser's own.
// The guard pins its execCommand: not writable, not configurable. The browser's own is both.
const native = (doc) =>
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(doc)), "execCommand")
    ?.writable === true;
clip.topNative = native(document);
// A child frame of its own making, laid over a button so the user's click lands in it, copying with
// the child's own execCommand: a way around a guard that only the top frame runs.
try {
  const child = document.createElement("iframe");
  child.id = "frame";
  child.style.cssText = "position:fixed;left:10px;top:200px;width:200px;height:60px;border:0";
  document.body.append(child);
  const inner = child.contentDocument;
  clip.childNative = native(inner);
  inner.body.innerHTML = '<p id="t" style="margin:0;height:60px">leak-frame</p>';
  inner.addEventListener("click", () => {
    const range = inner.createRange();
    range.selectNodeContents(inner.getElementById("t"));
    child.contentWindow.getSelection().removeAllRanges();
    child.contentWindow.getSelection().addRange(range);
    try { clip.frameCopy = String(inner.execCommand("copy")); } catch (error) { clip.frameCopy = "threw"; }
  });
} catch (error) {
  clip.childError = error.name;
}
</script>`;

/**
 * Input as the browser's own, through the DevTools protocol, so the page has the user's activation
 * whether or not the window has the system's focus. The fixture's alone; nothing in Gram does this.
 */
const input = (contents, method, params) => {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  return contents.debugger.sendCommand(method, params);
};

/** Clicks `id` in `contents`, so the page has the user's activation. */
async function clickAt(contents, id) {
  const box = await contents.executeJavaScript(
    `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
  );
  const [x, y] = box.map(Math.round);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await input(contents, "Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
  await delay(400);
}

/** Ctrl+C, as the keyboard's copy. */
async function pressCopy(contents) {
  const key = { key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 };
  await input(contents, "Input.dispatchKeyEvent", { type: "keyDown", ...key, commands: ["copy"] });
  await input(contents, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await delay(400);
}

/**
 * Loads `url` (the clip page) in `contents`, then clicks Copy and Download and presses Ctrl+C with
 * the clipboard set to a sentinel: what the page did, the clipboard after, and its title.
 */
async function clipboardProbe(contents, url) {
  await contents.loadURL(url).catch(() => {});
  const loaded = await titled(contents, "Clip", 5000);
  await clipboard.writeText("sentinel");
  contents.focus();
  await clickAt(contents, "copy");
  const afterClick = await clipboard.readText();
  // The same click as a script with the user's gesture, in case the input above had none.
  await contents.executeJavaScript(`document.getElementById("copy").click()`, true);
  await delay(400);
  const afterGesture = await clipboard.readText();
  await pressCopy(contents);
  const afterKeys = await clipboard.readText();
  // The edit menu's Copy, the user's own act on the page's selection.
  await clipboard.writeText("sentinel");
  contents.copy();
  await delay(400);
  const afterMenu = await clipboard.readText();
  await clipboard.writeText("sentinel");
  // The user's click in the child frame, with its gesture: the frame's own copy runs on it.
  const frame = contents.mainFrame.frames[0];
  await frame?.executeJavaScript(`document.body.click()`, true).catch(() => {});
  await delay(400);
  const afterFrame = frame === undefined ? "no frame" : await clipboard.readText();
  // The user's click in the top frame, then a copy through the child's own execCommand, which a
  // same-origin child may do on the activation its parent got.
  await clipboard.writeText("sentinel");
  await contents
    .executeJavaScript(
      `(() => {
        const f = document.getElementById("frame");
        const d = f.contentDocument;
        const r = d.createRange();
        r.selectNodeContents(d.getElementById("t"));
        f.contentWindow.getSelection().removeAllRanges();
        f.contentWindow.getSelection().addRange(r);
        window.clip.frameFromTop = String(d.execCommand("copy"));
      })()`,
      true,
    )
    .catch(() => {});
  await delay(400);
  const afterFrameFromTop = await clipboard.readText();
  await clickAt(contents, "dl");
  await contents.executeJavaScript(`document.getElementById("dl").click()`, true);
  await delay(400);
  await delay(400);
  const page = await contents.executeJavaScript("JSON.stringify(window.clip)").catch(() => "{}");
  if (contents.debugger.isAttached()) contents.debugger.detach();
  return {
    loaded,
    url: contents.getURL(),
    page: JSON.parse(page),
    afterClick,
    afterGesture,
    afterKeys,
    afterMenu,
    afterFrame,
    afterFrameFromTop,
    clipboard: await clipboard.readText(),
  };
}

/** Waits for `contents`' title to start with `prefix`; the title, or "timeout". */
async function titled(contents, prefix, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (contents.isDestroyed()) return "destroyed";
    const title = contents.getTitle();
    if (title.startsWith(prefix)) return title;
    await delay(100);
  }
  return "timeout";
}

async function main() {
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");
  // Every name resolves to loopback: a request that went out by name would be counted here.
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    "MAP *.example 127.0.0.1, MAP example.com 127.0.0.1",
  );
  await app.whenReady();

  // Gram's own server, and every other listener a page must never reach.
  const gram = await listener();
  const raw = await rawListeners();
  const preconnect = await rawListeners();

  // The page listener: the server's own serving code and headers.
  const folders = emptyPreviewFolders();
  const served = [];
  let origin = "";
  const handle = handleFileRequest(folders, {
    segment: PAGES_SEGMENT,
    headers: (requestOrigin) => pageHeaders(origin)(requestOrigin),
  });
  const pageListener = createServer((request, response) => {
    served.push(request.url);
    handle(request, response);
  });
  await new Promise((resolve) => pageListener.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${pageListener.address().port}`;
  // The same files with no headers of the server's: the session alone has to hold.
  const bare = await listener();
  const bareFolder = { folder: "" };

  // A synthetic worktree with the agent's draft, pinned with the server's pages store.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-pinned-fixture-")));
  const draft = join(dir, "worktree", "board");
  const otherDraft = join(dir, "worktree", "other");
  mkdirSync(draft, { recursive: true });
  mkdirSync(otherDraft, { recursive: true });
  writeFileSync(join(otherDraft, "index.html"), "<title>Other</title>");
  writeFileSync(join(otherDraft, "secret.js"), "window.otherRan = 'yes';");
  const pages = makePages(join(dir, "state", "pages"), () => Effect.void);
  mkdirSync(join(dir, "state"));
  const by = { threadId: "t-fixture", title: "Fixture thread" };
  const otherMeta = await Effect.runPromise(
    pages.pin({ workspaceId: "ws-fixture", by, entry: join(otherDraft, "index.html") }),
  );
  const otherShown = await Effect.runPromise(pages.shown("ws-fixture", otherMeta.id));
  const otherToken = await grantFolder(folders, otherShown.folder);
  const other = `${origin}/${PAGES_SEGMENT}/${otherToken}/secret.js`;
  writeFileSync(join(draft, "index.html"), probePage({ G: gram.port, other, raw, preconnect }));
  writeFileSync(join(draft, "app.js"), "window.appRan = 'yes';");
  writeFileSync(join(draft, "module.js"), "window.moduleRan = 'yes'; export {};");
  writeFileSync(join(draft, "style.css"), "#styled { color: rgb(1, 2, 3); }");
  writeFileSync(
    join(draft, "dot.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>',
  );
  writeFileSync(join(draft, "second.html"), "<title>Second page</title>");
  writeFileSync(join(draft, "clip.html"), clipPage);
  const meta = await Effect.runPromise(
    pages.pin({ workspaceId: "ws-fixture", by, entry: join(draft, "index.html") }),
  );
  // The worktree moves on after the pin: none of it reaches what was pinned.
  writeFileSync(join(draft, "index.html"), "<title>Board v2 from the worktree</title>");
  writeFileSync(join(draft, "app.js"), "window.appRan = 'changed';");
  const shown = await Effect.runPromise(pages.shown("ws-fixture", meta.id));
  const token = await grantFolder(folders, shown.folder);
  const pageUrl = `${origin}/${PAGES_SEGMENT}/${token}/index.html`;
  bareFolder.folder = shown.folder;

  // The shell's modules, as the desktop installs them, behind a fake trust check.
  const handlers = new Map();
  const ipc = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, (arg, event) => handler(event, arg)),
  };
  const win = new BrowserWindow({ show: true, width: 1000, height: 700 });
  await win.loadURL("about:blank");
  const sender = win.webContents;
  const invoke = (channel, arg) => handlers.get(channel)(arg, { sender });
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const pagesHost = installPages(ipc, { log, guardPreload: process.argv[3] });
  installPreview(ipc, { openLink: async () => false, log });
  // The app's IPC, which no page may reach: count anything it hears on any pages channel.
  const appHeard = [];
  for (const channel of Object.values(Channels)) ipcMain.on(channel, () => appHeard.push(channel));

  const downloads = [];
  const pagesSession = session.fromPartition(PAGES_PARTITION);
  pagesSession.on("will-download", (event) =>
    setImmediate(() => downloads.push(event.defaultPrevented)),
  );

  check(
    "nothing opens before the server says where pages load",
    (await invoke(Channels.pagesOpen, { key: meta.id, url: pageUrl })) === false,
  );
  pagesHost.setOrigin("http://localhost:1");
  pagesHost.setOrigin(`${origin}/`);
  check(
    "an origin that isn't the listener's exact one is ignored",
    (await invoke(Channels.pagesOpen, { key: meta.id, url: pageUrl })) === false,
  );
  pagesHost.setOrigin(origin);
  for (const [label, url] of [
    ["another port", `http://127.0.0.1:${gram.port}/${PAGES_SEGMENT}/${token}/index.html`],
    ["localhost", pageUrl.replace("127.0.0.1", "localhost")],
    ["a query", `${pageUrl}?x=1`],
    ["no token", `${origin}/${PAGES_SEGMENT}/index.html`],
    ["the preview files", `${origin}/gram-preview-files/${token}/index.html`],
    ["a web page", "https://example.com/"],
  ]) {
    check(
      `the shell refuses ${label}`,
      (await invoke(Channels.pagesOpen, { key: "refused", url })) === false,
    );
  }
  check(
    "the shell opens the pinned page",
    (await invoke(Channels.pagesOpen, { key: meta.id, url: pageUrl })) === true,
  );
  handlers.get(Channels.pagesBounds)(
    { key: meta.id, bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { sender },
  );
  const pageContents = allContents
    .getAllWebContents()
    .find((c) => !c.isDestroyed() && c.getURL().startsWith(pageUrl));
  check("the page is in the gram-pages session", pageContents?.session === pagesSession);
  const title = await titled(pageContents, "probe:");
  const probed = title.startsWith("probe:") ? JSON.parse(title.slice(6)) : {};
  await delay(500);
  await delay(300);
  const dialogTitle = pageContents.getTitle();
  const pinnedClip = await clipboardProbe(pageContents, pageUrl.replace("index.html", "clip.html"));
  const blockedEvery = (names) => names.filter((n) => probed[n] !== "blocked");
  check("the pinned copy loads, not the worktree's later edit", probed.ran === "yes", probed);
  check(
    "its own module script, style and image load from the bundle",
    probed.module === "yes" && probed.styled === "rgb(1, 2, 3)" && probed.ownImage === "loaded",
    probed,
  );
  check("it runs at an opaque origin", probed.origin === "null", probed.origin);
  check(
    "no fetch reaches anything, its own files, Gram, a name, another page or the internet",
    blockedEvery(["ownFile", "gramGet", "gramPost", "byName", "otherPage", "internet"]).length ===
      0,
    probed,
  );
  check(
    "no socket, beacon or event stream goes out",
    probed.socket !== "reached" &&
      probed.eventSource !== "reached" &&
      !gram.seen.some((s) => s.url === "/beacon" || s.url === "/ws" || s.url === "/events"),
    { probed, seen: gram.seen },
  );
  check("Gram's server heard nothing", gram.seen.length === 0, gram.seen);
  check(
    "no STUN packet or TURN connection left",
    raw.packets.length === 0 && raw.connections.length === 0,
    { packets: raw.packets.length, connections: raw.connections.length },
  );
  check(
    "no preconnect connection left",
    preconnect.connections.length === 0,
    preconnect.connections,
  );
  check(
    "another page's files on the same listener were never asked for",
    !served.some((url) => url.includes(otherToken)),
    served,
  );
  check(
    "no bridge, Node or app IPC",
    probed.bridge === "undefined,undefined,undefined,undefined" && appHeard.length === 0,
    { bridge: probed.bridge, appHeard },
  );
  check(
    "no storage or cookies",
    probed.storage === "refused" && probed.cookie !== "set:a=b" && probed.indexedDB === "refused",
    probed,
  );
  check(
    "no popup, permission, form or dialog",
    probed.popup === "denied" &&
      probed.notification === "denied" &&
      dialogTitle.includes('"alert":"returned"') &&
      !gram.seen.some((s) => s.url === "/form"),
    probed,
  );
  check(
    "the clipboard holds what the user put there",
    pinnedClip.afterClick === "sentinel" &&
      pinnedClip.afterGesture === "sentinel" &&
      pinnedClip.afterFrame === "sentinel" &&
      pinnedClip.afterFrameFromTop === "sentinel" &&
      pinnedClip.page.topNative === false &&
      pinnedClip.page.childNative !== true &&
      pinnedClip.page.execCopy === "false" &&
      pinnedClip.page.asyncCopy !== "written" &&
      pinnedClip.page.copyEvent === undefined,
    pinnedClip,
  );
  check(
    "the user's own copy still copies their selection, as the page can't change it",
    pinnedClip.afterMenu === "Copy me" && pinnedClip.afterKeys !== "leak-copy-event",
    pinnedClip,
  );
  // The sandbox stops a download before the session hears of it; without the sandbox header
  // (below) the session's own refusal has to hold.
  check("no download started", downloads.length === 0, downloads);
  // Navigation: within its own files, and nowhere else.
  await pageContents.loadURL(pageUrl).catch(() => {});
  await titled(pageContents, "Board v1", 5000);
  await pageContents.executeJavaScript(`location.href = "http://127.0.0.1:${gram.port}/away"`);
  await delay(800);
  check(
    "it can't navigate away",
    pageContents.getURL().startsWith(pageUrl) && gram.seen.length === 0,
    pageContents.getURL(),
  );
  await pageContents.executeJavaScript(`location.href = ${JSON.stringify(other)}`);
  await delay(800);
  check(
    "nor to another page's files",
    pageContents.getURL().startsWith(pageUrl) && !served.some((url) => url.includes(otherToken)),
    pageContents.getURL(),
  );
  await pageContents.executeJavaScript(`document.getElementById("own-link").click()`);
  const second = await titled(pageContents, "Second page", 5000);
  check("it may open its own files", second === "Second page", {
    second,
    url: pageContents.getURL(),
  });

  // The preview's local session, where agents' pages are, never loads a pinned page.
  const servedBefore = served.length;
  await invoke(Channels.previewOpen, { threadId: "t-agent", url: pageUrl });
  await delay(800);
  check(
    "the Preview tab's local session refuses a pinned page's URL",
    served.length === servedBefore,
    served.slice(servedBefore),
  );

  // The session alone: the same files served with no CSP or sandbox header still reach nothing.
  bare.server.removeAllListeners("request");
  bare.server.on("request", (request, response) => {
    const name = (request.url ?? "").split("/").at(-1) ?? "";
    const types = {
      html: "text/html",
      js: "text/javascript",
      css: "text/css",
      svg: "image/svg+xml",
    };
    try {
      const body = readFileSync(join(bareFolder.folder, name));
      response.writeHead(200, { "content-type": types[name.split(".").at(-1)] ?? "text/plain" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const bareOrigin = `http://127.0.0.1:${bare.port}`;
  const bareUrl = `${bareOrigin}/${PAGES_SEGMENT}/${token}/index.html`;
  pagesHost.setOrigin(bareOrigin);
  await invoke(Channels.pagesOpen, { key: "bare", url: `${bareUrl}#no-dialog` });
  const bareContents = allContents
    .getAllWebContents()
    .find((c) => !c.isDestroyed() && c.getURL().startsWith(bareUrl));
  await clipboard.writeText("sentinel");
  const bareTitle = bareContents === undefined ? "missing" : await titled(bareContents, "probe:");
  const bareProbed = bareTitle.startsWith("probe:") ? JSON.parse(bareTitle.slice(6)) : {};
  check(
    "without the listener's headers, the session alone still reaches nothing",
    bareProbed.ran === "yes" &&
      ["gramGet", "gramPost", "byName", "otherPage", "internet"].every(
        (n) => bareProbed[n] === "blocked",
      ) &&
      bareProbed.socket !== "reached" &&
      gram.seen.length === 0 &&
      raw.packets.length === 0 &&
      raw.connections.length === 0,
    {
      bareProbed,
      seen: gram.seen,
      packets: raw.packets.length,
      connections: raw.connections.length,
    },
  );

  const bareClip = await clipboardProbe(
    bareContents,
    `${bareUrl.replace("index.html", "clip.html")}#no-dialog`,
  );
  check(
    "without the listener's headers, the session sandboxes the page itself: the guard runs, and a frame it makes is out of its reach",
    bareClip.page.topNative === false &&
      bareClip.page.childNative === undefined &&
      bareClip.page.childError !== undefined &&
      bareClip.afterGesture === "sentinel" &&
      bareClip.afterFrameFromTop === "sentinel" &&
      bareClip.afterMenu === "Copy me",
    bareClip,
  );
  // The page can't start a download at all; one started in its session regardless is refused.
  bareContents.downloadURL(`${bareOrigin}/${PAGES_SEGMENT}/${token}/app.js`);
  await delay(800);
  check(
    "the session refuses a download it is asked for",
    downloads.length > 0 && downloads.every((prevented) => prevented),
    downloads,
  );

  // The control: the bare page in a session without the policy reaches the listeners and the
  // clipboard, so each probe above can see what it looks for.
  const controlSession = session.fromPartition("fixture-control");
  await controlSession.setProxy({ mode: "direct" });
  const control = new WebContentsView({
    webPreferences: { session: controlSession, sandbox: true },
  });
  win.contentView.addChildView(control);
  control.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  await control.webContents.loadURL(`${bareUrl}#no-dialog`).catch(() => {});
  await clipboard.writeText("sentinel");
  await delay(1200);
  const controlTitle = await titled(control.webContents, "probe:");
  const controlProbed = controlTitle.startsWith("probe:") ? JSON.parse(controlTitle.slice(6)) : {};
  const controlDownloads = [];
  controlSession.on("will-download", (event, item) => {
    controlDownloads.push(item.getFilename());
    event.preventDefault();
  });
  const controlClip = await clipboardProbe(
    control.webContents,
    `${bareUrl.replace("index.html", "clip.html")}#no-dialog`,
  );
  check(
    "control: without the policy the same page reaches Gram, RTC listeners and the clipboard",
    controlProbed.gramGet === "reached" &&
      gram.seen.length > 0 &&
      (raw.packets.length > 0 || raw.connections.length > 0) &&
      controlClip.afterGesture.startsWith("leak-") &&
      controlClip.page.topNative === true &&
      controlClip.page.childNative === true &&
      controlDownloads.length > 0,
    {
      controlProbed,
      seen: gram.seen.length,
      packets: raw.packets.length,
      connections: raw.connections.length,
      clip: controlClip,
      downloads: controlDownloads,
    },
  );
  control.webContents.close();
  win.destroy();
  raw.close();
  preconnect.close();
  process.stdout.write(`${JSON.stringify({ type: "fixture.result", results, failures })}\n`);
  for (const listening of [gram, bare]) listening.server.close();
  pageListener.close();
  app.quit();
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ type: "fixture.result", results, failures: [...failures, String(error?.stack ?? error)] })}\n`,
  );
  app.exit(1);
});
