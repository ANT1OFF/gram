// Disposable native fixture for the Preview tab's web session. No Gram store, installed app,
// provider CLI, personal browser or outside network. The web session's one lookup is told what a
// real resolver would answer for each synthetic name: a public address, which its dial connects to
// this fixture's site listener, or a rebound, failing or empty answer. Chromium's own resolver
// maps every one of those names to loopback, and an owned HTTP proxy is set as the system's, so a
// connection that went around the session's proxy would reach a loopback listener and be seen.
import { app, BrowserWindow, session, WebContentsView, webContents as allContents } from "electron";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";

import { Channels } from "../../../../packages/shell/src/channels.ts";
import {
  installPreview,
  PREVIEW_PARTITIONS,
} from "../../../../packages/shell/src/modules/preview/main.ts";

const results = [];
const failures = [];
const check = (label, ok, detail) => {
  (ok ? results : failures).push(
    detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`,
  );
};
const contentsAt = (prefix) =>
  allContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith(prefix));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A synthetic private address; nothing is ever sent to it, the proxy's dial maps it home. */
const LAN = "10.77.0.9";
/** A second, which no page the user opened ever names. */
const LAN2 = "10.77.0.10";

/** A listener on loopback that records what reached it. */
async function listener(respond) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, cookie: request.headers.cookie ?? "" });
    respond(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: server.address().port, server };
}

/** A UDP and a TCP listener on loopback, counting what reaches them: a STUN and a TURN server. */
async function rtcListeners() {
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

/** A private page embedding `frame`, titling itself with what its child said. */
const opaqueParent = (frame) => `<!doctype html><title>Opaque parent</title>${frame}<script>
const said = {};
addEventListener("message", (event) => Object.assign(said, event.data));
setTimeout(() => (document.title = "opaque:" + JSON.stringify(said)), 6000);
</script>`;

/** A page that fetches each lookup case on Gram's port and titles itself with what reached. */
const lookupsPage = (port) => `<!doctype html><title>Lookups</title><script>
const results = {};
const probe = (name, url) =>
  Promise.race([
    fetch(url, { mode: "no-cors" }).then(() => (results[name] = "reached"), () => (results[name] = "blocked")),
    new Promise((resolve) => setTimeout(() => resolve((results[name] = "timeout")), 5000)),
  ]);
(async () => {
  await probe("control", location.origin + "/plain");
  for (const name of ["flip", "flip2", "flip3", "reject", "empty", "throw"])
    await probe(name, "http://" + name.replace(/\\d$/, "") + ".example:${port}/" + name);
  results.flip = [results.flip, results.flip2, results.flip3].every((r) => r === "blocked") ? "blocked" : "reached";
  document.title = "lookups:" + JSON.stringify(results);
})();
</script>`;

/** A page that gathers ICE against `servers`, then titles itself "rtc-done". */
const rtcPage = (servers) => `<!doctype html><title>RTC</title><script>
(async () => {
  try {
    const pc = new RTCPeerConnection({ iceServers: ${JSON.stringify(servers)} });
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());
  } catch (error) {
    document.title = "rtc-error:" + error.name;
    return;
  }
  setTimeout(() => (document.title = "rtc-done"), 4000);
})();
</script>`;

async function main() {
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");

  // Gram's own server: what a remote page must never reach, with or without its launch cookie.
  const gram = await listener((_request, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end("{}"),
  );
  // A dev server on loopback, the local session's, and an agent's page as show_panel opens one.
  const dev = await listener((request, response) => {
    if (request.url === "/agent")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<title>Agent page</title><script>setTimeout(() => (location.href = "http://site.example:${site.port}/agent-action"), 1500);</script>`,
        );
    if (request.url === "/agent-redirect-page")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<title>Agent page</title><script>setTimeout(() => (location.href = "/agent-redirect"), 1500);</script>`,
        );
    if (request.url === "/agent-redirect")
      return response
        .writeHead(302, { location: `http://site.example:${site.port}/agent-redirect-action` })
        .end();
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        `<title>Dev app</title><a id="out" href="http://site.example:${site.port}/plain">Docs</a>`,
      );
  });
  const rtc = await rtcListeners();
  const loopbackServers = [
    { urls: `stun:127.0.0.1:${rtc.udpPort}` },
    { urls: `stun:stun.example:${rtc.udpPort}` },
    {
      urls: [
        `turn:127.0.0.1:${rtc.tcpPort}?transport=tcp`,
        `turn:turn.example:${rtc.tcpPort}?transport=tcp`,
      ],
      username: "fixture",
      credential: "fixture",
    },
  ];
  // A TURN server on a private network, by its address: the proxy's dial would reach the same
  // listener, so a connection it let through would be counted.
  const rtcServers = [
    ...loopbackServers,
    {
      urls: [`turn:${LAN}:${rtc.tcpPort}?transport=tcp`],
      username: "fixture",
      credential: "fixture",
    },
  ];
  // A page on the private network that the user opens themselves.
  // What the second private address reaches, counted by connection, whatever the protocol.
  const unused = { connections: 0 };
  const unusedServer = createTcpServer((socket) => {
    unused.connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => unusedServer.listen(0, "127.0.0.1", resolve));
  const unusedPort = unusedServer.address().port;
  /** An opaque child's script: says it ran and its origin, tries a fetch and TURN/TCP. */
  const opaqueChild = () =>
    `<script>
parent.postMessage({ ran: true, origin: self.origin }, "*");
fetch("http://${LAN2}:${unusedPort}/opaque-fetch", { mode: "no-cors" }).then(
  () => parent.postMessage({ fetch: "reached" }, "*"),
  () => parent.postMessage({ fetch: "blocked" }, "*"),
);
(async () => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "turn:${LAN2}:${unusedPort}?transport=tcp", username: "x", credential: "x" }],
  });
  pc.createDataChannel("probe");
  await pc.setLocalDescription(await pc.createOffer());
})();
</script>`;
  const lan = await listener((request, response) => {
    if (request.url === "/opaque-data")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          opaqueParent(
            `<iframe sandbox="allow-scripts" src="data:text/html,${encodeURIComponent(opaqueChild())}"></iframe>`,
          ),
        );
    if (request.url === "/opaque-srcdoc")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          opaqueParent(
            `<iframe sandbox="allow-scripts" srcdoc="${opaqueChild().replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`,
          ),
        );
    if (request.url === "/with-frame")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<title>LAN frame</title><iframe src="http://site.example:${site.port}/mark-embed"></iframe>`,
        );
    if (request.url === "/with-link")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<title>LAN link</title><a id="out" href="http://site.example:${site.port}/mark-from-lan">Out</a>`,
        );
    response.writeHead(200, { "content-type": "text/html" }).end("<title>LAN page</title>");
  });
  // A system proxy that would route any name to a loopback listener: the web session must never
  // use it.
  const systemProxy = { connections: 0 };
  const proxyServer = createTcpServer((socket) => {
    systemProxy.connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const G = gram.port;
  const page = (
    port,
  ) => `<!doctype html><title>Remote page</title><a id="dl" download href="/file.bin">x</a>
<script>
const results = {};
const settle = (promise, ms = 3000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))]);
const probe = (name, url, init = {}) =>
  settle(
    fetch(url, { mode: "no-cors", credentials: "include", ...init }).then(
      () => (results[name] = "reached"),
      () => (results[name] = "blocked"),
    ),
  );
(async () => {
  await probe("gramGet", "http://127.0.0.1:${G}/api/threads");
  await probe("gramPost", "http://127.0.0.1:${G}/api/threads", { method: "POST", body: "x" });
  await probe("localhostName", "http://localhost:${G}/api");
  await probe("subdomainLocalhost", "http://gram.localhost:${G}/api");
  await probe("zeroAddress", "http://0.0.0.0:${G}/api");
  await probe("rebound", "http://rebind.example:${G}/api");
  await probe("privateNetwork", "http://192.168.255.254/");
  await probe("metadata", "http://169.254.169.254/latest/meta-data/");
  await probe("ownSite", "http://site.example:${port}/plain");
  results.socket = await settle(new Promise((resolve) => {
    const socket = new WebSocket("ws://127.0.0.1:${G}/ws");
    socket.onopen = () => resolve("reached");
    socket.onerror = () => resolve("blocked");
  }));
  results.cookie = document.cookie;
  results.bridge = [typeof window.gram, typeof process, typeof require].join(",");
  results.notification = await settle(Notification.requestPermission());
  results.geolocation = await settle(new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(() => resolve("granted"), (e) => resolve("denied:" + e.code)),
  ));
  results.camera = await settle(
    navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", (e) => "denied:" + e.name),
  );
  results.clipboard = await settle(navigator.clipboard.readText().then(() => "granted", (e) => "denied:" + e.name));
  document.getElementById("dl").click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.title = "done:" + JSON.stringify(results);
})();
</script>`;
  const site = await listener((request, response) => {
    if (request.url === "/redirect-local")
      return response.writeHead(302, { location: `http://127.0.0.1:${G}/redirected` }).end();
    if (request.url === "/redirect-rebound")
      return response.writeHead(302, { location: `http://rebind.example:${G}/redirected` }).end();
    if (request.url === "/redirect-private")
      return response.writeHead(302, { location: "http://192.168.255.254/" }).end();
    if (request.url === "/file.bin")
      return response.writeHead(200, { "content-type": "application/octet-stream" }).end("bytes");
    if (request.url === "/go-local")
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<title>Go local</title><script>location.href = "http://127.0.0.1:${G}/navigated";</script>`,
        );
    if (request.url === "/plain")
      return response.writeHead(200, { "content-type": "text/html" }).end("<title>Plain</title>");
    if (request.url?.startsWith("/mark"))
      return response
        .writeHead(200, { "content-type": "text/html" })
        .end(`<title>${request.url.slice(1)}</title>`);
    if (request.url === "/rtc")
      return response.writeHead(200, { "content-type": "text/html" }).end(rtcPage(rtcServers));
    if (request.url === "/rtc-control")
      return response.writeHead(200, { "content-type": "text/html" }).end(rtcPage(loopbackServers));
    if (request.url === "/lookups")
      return response.writeHead(200, { "content-type": "text/html" }).end(lookupsPage(G));
    response.writeHead(200, { "content-type": "text/html" }).end(page(site.port));
  });
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    [
      "site.example",
      "rebind.example",
      "gram.localhost",
      "flip.example",
      "reject.example",
      "empty.example",
      "throw.example",
      "stun.example",
      "turn.example",
    ]
      .map((name) => `MAP ${name} 127.0.0.1`)
      .join(", "),
  );
  app.commandLine.appendSwitch("proxy-server", `http://127.0.0.1:${proxyServer.address().port}`);

  // As an https site would be, so camera and clipboard are asked for, not just absent.
  app.commandLine.appendSwitch(
    "unsafely-treat-insecure-origin-as-secure",
    `http://site.example:${site.port}`,
  );

  await app.whenReady();

  // The app's own session holds the launch cookie, and the local session a dev app's.
  await session.defaultSession.cookies.set({
    url: `http://127.0.0.1:${G}/`,
    name: "gram_launch",
    value: "synthetic-launch-token",
  });
  const local = session.fromPartition(PREVIEW_PARTITIONS.local);
  const web = session.fromPartition(PREVIEW_PARTITIONS.web);
  await local.cookies.set({
    url: `http://127.0.0.1:${dev.port}/`,
    name: "dev_app",
    value: "local",
  });
  await web.cookies.set({
    url: `http://site.example:${site.port}/`,
    name: "site_sign_in",
    value: "user",
  });

  const handlers = new Map();
  const ipc = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, (arg, event) => handler(event, arg)),
  };
  const sender = { send: () => {}, isDestroyed: () => false, getZoomFactor: () => 1 };
  const invoke = (channel, arg) => handlers.get(channel)(arg, { sender });
  const downloads = [];
  // Registered before the preview's own listener, so read once every listener has run.
  web.on("will-download", (event) => setImmediate(() => downloads.push(event.defaultPrevented)));
  const linkQuestions = [];
  const lookups = {};
  const host = installPreview(ipc, {
    openLink: async (url) => {
      linkQuestions.push(url);
      return false;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    lookupWebHost: (name) => {
      lookups[name] = (lookups[name] ?? 0) + 1;
      switch (name) {
        case "rebind.example":
          return Promise.resolve(["127.0.0.1"]);
        // A public answer, then a rebound one, alternately: whichever the connection gets, it
        // goes only where its own answer was checked.
        case "flip.example":
          return Promise.resolve([lookups[name] % 2 === 1 ? "93.184.216.34" : "127.0.0.1"]);
        case "reject.example":
          return Promise.reject(new Error("SERVFAIL"));
        case "empty.example":
          return Promise.resolve([]);
        case "throw.example":
          throw new Error("resolver gone");
        default:
          return Promise.resolve(["93.184.216.34"]);
      }
    },
    // The synthetic public address is the site listener, on its own port only.
    // Anything else at it goes nowhere (the discard port, closed), never out to the internet.
    // The synthetic private address is the fixture's loopback listeners, on any port, so a
    // connection the proxy let through to it is seen.
    dialWebAddress: (address, port) =>
      address === "93.184.216.34"
        ? connect({ host: "127.0.0.1", port: port === site.port ? port : 9 })
        : connect({ host: address === LAN || address === LAN2 ? "127.0.0.1" : address, port }),
  });
  const T = "t-web";
  const state = () => invoke(Channels.previewStateGet, { threadId: T });
  const waitTitle = async (prefix, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await delay(100)) {
      const now = await state();
      if (now?.title?.startsWith(prefix)) return now;
    }
    return state();
  };

  // Separate sessions, from the app and from each other.
  check(
    "the web session is its own, apart from the app's and the local one",
    web !== session.defaultSession && web !== local && web.storagePath === null,
  );
  const webCookies = await web.cookies.get({});
  check(
    "the web session holds neither Gram's launch cookie nor a dev app's",
    webCookies.every((c) => c.name !== "gram_launch" && c.name !== "dev_app"),
    webCookies.map((c) => c.name),
  );
  const localCookies = await local.cookies.get({});
  check(
    "the local session, where agents drive, holds none of the user's web sign-ins",
    localCookies.every((c) => c.name !== "site_sign_in"),
    localCookies.map((c) => c.name),
  );

  // Schemes that never open.
  for (const url of [
    "file:///etc/hosts",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "chrome://version",
    "devtools://devtools/bundled/inspector.html",
    "view-source:http://site.example/",
    "https://user@site.example/",
  ]) {
    check(
      `refuses to open ${url}`,
      (await invoke(Channels.previewOpen, { threadId: T, url })) === false &&
        (await invoke(Channels.previewOpenWeb, { threadId: T, url })) === false,
    );
  }

  // A web page opens only on the address strip's own channel; loopback never on it.
  const siteUrl = `http://site.example:${site.port}/`;
  check(
    "the loopback channel refuses a web page, as a re-opened agent page would ask",
    (await invoke(Channels.previewOpen, { threadId: T, url: siteUrl })) === false &&
      (await invoke(Channels.previewOpen, {
        threadId: T,
        url: "https://agent-chosen.example/act",
      })) === false &&
      !allContents.getAllWebContents().some((c) => !c.isDestroyed() && c.session === web),
  );
  check(
    "the web channel refuses loopback",
    (await invoke(Channels.previewOpenWeb, {
      threadId: T,
      url: `http://127.0.0.1:${dev.port}/`,
    })) === false,
  );
  // A remote page loads, in the web session, sandboxed, and reaches nothing of this computer.
  check(
    "opens a remote page",
    (await invoke(Channels.previewOpenWeb, { threadId: T, url: siteUrl })) === true,
  );
  contentsAt(siteUrl)?.setBackgroundThrottling(false);
  const done = await waitTitle("done:");
  if (!done?.title?.startsWith("done:"))
    failures.push(
      `partial probes: ${await contentsAt(siteUrl)
        ?.executeJavaScript("JSON.stringify(globalThis.results)")
        .catch((error) => String(error))}`,
    );
  const probes = done?.title?.startsWith("done:")
    ? JSON.parse(done.title.slice("done:".length))
    : { title: done?.title };
  check(
    "the remote page loaded and ran",
    done?.url === siteUrl && probes.ownSite === "reached",
    done,
  );
  for (const name of [
    "gramGet",
    "gramPost",
    "localhostName",
    "subdomainLocalhost",
    "zeroAddress",
    "rebound",
    "privateNetwork",
    "metadata",
    "socket",
  ]) {
    check(`the remote page is refused ${name}`, probes[name] === "blocked", probes[name]);
  }
  check(
    "the remote page reads only its own cookie",
    probes.cookie === "site_sign_in=user",
    probes.cookie,
  );
  check(
    "the remote page gets no bridge, Node or require",
    probes.bridge === "undefined,undefined,undefined",
    probes.bridge,
  );
  check("notifications are denied", probes.notification === "denied", probes.notification);
  check("location is denied", probes.geolocation === "denied:1", probes.geolocation);
  check("the camera is denied", String(probes.camera).startsWith("denied"), probes.camera);
  check("the clipboard is denied", String(probes.clipboard).startsWith("denied"), probes.clipboard);
  check("a download is refused", downloads.length > 0 && downloads.every(Boolean), downloads);
  const remote = contentsAt(siteUrl);
  const prefs = remote?.getLastWebPreferences();
  check(
    "the remote page is sandboxed, isolated and without Node",
    remote?.session === web &&
      prefs?.sandbox === true &&
      prefs?.contextIsolation === true &&
      prefs?.nodeIntegration === false,
    prefs && {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      node: prefs.nodeIntegration,
    },
  );

  // A site can't send the pane to this computer, or a private network, by a script or a redirect.
  for (const path of ["/go-local", "/redirect-local", "/redirect-rebound", "/redirect-private"]) {
    const seen = gram.seen.length;
    await invoke(Channels.previewOpenWeb, {
      threadId: T,
      url: `http://site.example:${site.port}${path}`,
    });
    await delay(1500);
    const now = await state();
    // A request the session cancels may still commit its error page at the address it was for.
    check(
      `${path} reaches nothing of this computer`,
      gram.seen.length === seen &&
        (!String(now?.url).includes(`:${G}/`) || now?.error !== undefined),
      { url: now?.url, error: now?.error },
    );
  }
  check("Gram's server saw no request at all", gram.seen.length === 0, gram.seen);

  // An agent never gets the user's web page: asking without making one gets nothing, and making
  // one closes it for a page of its own in the local session.
  check("an agent can't take the user's web page", host.contentsFor(T, false) === undefined);
  const before = contentsAt(`http://site.example:${site.port}`);
  const agentPage = host.contentsFor(T, true);
  check(
    "an agent's page is a new one, in the local session",
    agentPage !== undefined &&
      agentPage !== before &&
      agentPage.session === local &&
      before?.isDestroyed() !== false,
  );

  // A local page leaving loopback never crosses into the web session, where the user's sign-ins
  // are: not by the user's click, nor an agent's page (as show_panel opens one, with no driver)
  // by a script or a redirect. Each goes to the link question; the site sees nothing.
  // Shown in a window, as the app shows them, so the link question has one to ask in.
  const win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  await win.loadURL("about:blank");
  const show = (threadId) =>
    handlers.get(Channels.previewBounds)(
      { threadId, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { sender: win.webContents },
    );
  const seenBefore = site.seen.length;
  const U = "t-dev";
  await invoke(Channels.previewOpen, { threadId: U, url: `http://127.0.0.1:${dev.port}/` });
  show(U);
  const devPage = contentsAt(`http://127.0.0.1:${dev.port}/`);
  await devPage?.executeJavaScript(`document.getElementById("out").click()`, true);
  for (const [thread, path] of [
    ["t-agent-script", "/agent"],
    ["t-agent-redirect", "/agent-redirect-page"],
  ]) {
    await invoke(Channels.previewOpen, {
      threadId: thread,
      url: `http://127.0.0.1:${dev.port}${path}`,
    });
    show(thread);
  }
  await delay(3500);
  const crossed = site.seen.slice(seenBefore);
  check(
    "a local page's link, script or redirect never reaches the site",
    crossed.length === 0,
    crossed,
  );
  check(
    "each goes to the link question instead",
    ["/plain", "/agent-action", "/agent-redirect-action"].every((path) =>
      linkQuestions.includes(`http://site.example:${site.port}${path}`),
    ),
    linkQuestions,
  );
  check(
    "the pages stay in the local session",
    ["t-dev", "t-agent-script", "t-agent-redirect"].every(
      (thread) => host.contentsOf(thread)?.session === local,
    ),
  );
  check(
    "no web page was made for them",
    !allContents.getAllWebContents().some((c) => !c.isDestroyed() && c.session === web),
  );

  // The web session's connections go through its own proxy, never the system's.
  await invoke(Channels.previewOpenWeb, {
    threadId: "t-lookups",
    url: `http://site.example:${site.port}/lookups`,
  });
  const lookupsDone = await (async () => {
    for (const end = Date.now() + 30_000; Date.now() < end; await delay(100)) {
      const now = await invoke(Channels.previewStateGet, { threadId: "t-lookups" });
      if (now?.title?.startsWith("lookups:")) return JSON.parse(now.title.slice("lookups:".length));
    }
    return {};
  })();
  const proxyRule = await web.resolveProxy(`http://site.example:${site.port}/`);
  check(
    "the web session's proxy is its own",
    /^PROXY 127\.0\.0\.1:\d+$/.test(proxyRule),
    proxyRule,
  );
  // Another process on this computer, an agent's CLI say, gets nothing from it without the
  // credential Chromium alone is given.
  const relay = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: Number(proxyRule.split(":").at(-1)) });
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("close", () => resolve(text.split("\r\n")[0]));
    socket.on("error", () => resolve("error"));
    socket.write(`CONNECT site.example:${site.port} HTTP/1.1\r\nHost: site.example\r\n\r\n`);
  });
  check("the proxy is no relay for another process", relay.startsWith("HTTP/1.1 407"), relay);
  check("the system proxy is never used", systemProxy.connections === 0, systemProxy.connections);
  check("a public name still loads through it", lookupsDone.control === "reached", lookupsDone);
  // Refused at the request check (a failing lookup) or by the proxy (a rebound answer, which a
  // plain http request gets as the proxy's own 403 page): either way, nothing reaches the listener.
  for (const name of ["flip", "reject", "empty", "throw"]) {
    const reached = gram.seen.filter((request) => request.url.startsWith(`/${name}`));
    check(`${name}.example reaches nothing`, reached.length === 0, {
      fetch: lookupsDone[name],
      reached,
    });
  }
  check("a rebound connection reached no loopback listener", gram.seen.length === 0, gram.seen);
  check("flip.example was looked up more than once", (lookups["flip.example"] ?? 0) >= 2, lookups);

  // WebRTC: no STUN over UDP, no TURN over TCP, to loopback by address or by a rebound name.
  const rtcDone = async (contents) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await delay(100)) {
      if (contents === undefined || contents.getTitle().startsWith("rtc-")) break;
    }
    return contents?.getTitle();
  };
  // The review's case: the user's own page on the private network, at the very address and port
  // the public page's TURN server names, open in another thread all the while.
  await invoke(Channels.previewOpenWeb, {
    threadId: "t-lan-turn",
    url: `http://${LAN}:${rtc.tcpPort}/`,
  });
  await delay(1500);
  const privateOwn = rtc.connections.length;
  check(
    "the private page is in its own session, and reached its own address",
    host.contentsOf("t-lan-turn") === undefined &&
      allContents
        .getAllWebContents()
        .some(
          (c) =>
            !c.isDestroyed() &&
            c.getURL().startsWith(`http://${LAN}:${rtc.tcpPort}`) &&
            c.session !== web &&
            c.session !== local,
        ) &&
      privateOwn > 0,
    { privateOwn },
  );
  await invoke(Channels.previewOpenWeb, {
    threadId: "t-rtc",
    url: `http://site.example:${site.port}/rtc`,
  });
  const rtcContents = contentsAt(`http://site.example:${site.port}/rtc`);
  rtcContents?.setBackgroundThrottling(false);
  const rtcTitle = await rtcDone(rtcContents);
  check("the web page ran its WebRTC probe", rtcTitle === "rtc-done", rtcTitle);
  check(
    "the web session's WebRTC sends no UDP",
    rtc.packets.length === 0 &&
      rtcContents?.getWebRTCIPHandlingPolicy() === "disable_non_proxied_udp",
    { packets: rtc.packets.length, policy: rtcContents?.getWebRTCIPHandlingPolicy() },
  );
  check(
    "the web session's WebRTC opens no TCP to loopback, or to a private address (TURN over TCP), " +
      "even one another thread's private page is open at",
    rtc.connections.length === privateOwn,
    { before: privateOwn, after: rtc.connections.length },
  );
  // The user's own page on the private network still opens from the address strip.
  await invoke(Channels.previewOpenWeb, { threadId: "t-lan", url: `http://${LAN}:${lan.port}/` });
  await delay(1500);
  const lanState = await invoke(Channels.previewStateGet, { threadId: "t-lan" });
  check(
    "the user's own private page loads",
    lanState?.title === "LAN page" && lan.seen.length === 1,
    { state: lanState, seen: lan.seen.length },
  );
  // A private page's session runs nothing public: its public frame doesn't load, and its link to
  // the internet opens in the shared session.
  const siteSeen = site.seen.length;
  await invoke(Channels.previewOpenWeb, {
    threadId: "t-lan",
    url: `http://${LAN}:${lan.port}/with-frame`,
  });
  await delay(1500);
  check(
    "a private page's public frame doesn't load",
    !site.seen.slice(siteSeen).some((r) => r.url === "/mark-embed"),
    site.seen.slice(siteSeen),
  );
  await invoke(Channels.previewOpenWeb, {
    threadId: "t-lan",
    url: `http://${LAN}:${lan.port}/with-link`,
  });
  await delay(1000);
  await contentsAt(`http://${LAN}:${lan.port}/with-link`)
    ?.executeJavaScript(`document.getElementById("out").click()`, true)
    .catch(() => {});
  await delay(1500);
  const followedOut = contentsAt(`http://site.example:${site.port}/mark-from-lan`);
  check(
    "a private page's link to the internet opens in the shared session",
    followedOut?.session === web &&
      (await invoke(Channels.previewStateGet, { threadId: "t-lan" }))?.webView !== undefined,
    followedOut?.getURL(),
  );

  // The fourth review's case: an opaque, sandboxed child of the user's private page (a data: URL,
  // then srcdoc) runs, its fetch to a second private address is refused, and its TURN/TCP there
  // reaches nothing either: the session's proxy reaches only the destination the user opened.
  for (const kind of ["data", "srcdoc"]) {
    const thread = `t-opaque-${kind}`;
    const connectedBefore = unused.connections;
    await invoke(Channels.previewOpenWeb, {
      threadId: thread,
      url: `http://${LAN}:${lan.port}/opaque-${kind}`,
    });
    let said = {};
    for (const end = Date.now() + 20_000; Date.now() < end; await delay(100)) {
      const title = (await invoke(Channels.previewStateGet, { threadId: thread }))?.title ?? "";
      if (title.startsWith("opaque:")) {
        said = JSON.parse(title.slice("opaque:".length));
        break;
      }
    }
    await delay(2000);
    check(
      `an opaque ${kind} child of a private page ran, with an opaque origin, and its fetch to another private address was refused`,
      said.ran === true && said.origin === "null" && said.fetch === "blocked",
      said,
    );
    check(
      `that child's TURN/TCP to another private address reaches nothing`,
      unused.connections === connectedBefore,
      { before: connectedBefore, after: unused.connections },
    );
  }

  // Re-opening: the user's web page the shell closed for newer threads' opens again by its token,
  // at the shell's own record; a page an agent replaced never does.
  const evictAll = async (prefix) => {
    for (let i = 0; i < 4; i++)
      await invoke(Channels.previewOpen, {
        threadId: `${prefix}-${i}`,
        url: `http://127.0.0.1:${dev.port}/`,
      });
  };
  const markSeen = (path) => site.seen.filter((r) => r.url === path).length;
  await invoke(Channels.previewOpenWeb, {
    threadId: "t-reopen",
    url: `http://site.example:${site.port}/mark-reopen`,
  });
  await delay(800);
  const tokenA = (await invoke(Channels.previewStateGet, { threadId: "t-reopen" }))?.webView;
  check(
    "the loopback channel can't take a web view's token",
    (await invoke(Channels.previewReopenWeb, { threadId: "t-reopen", token: tokenA })) === false,
  );
  await evictAll("t-evict-a");
  check(
    "the user's web page was closed for newer threads'",
    (await invoke(Channels.previewStateGet, { threadId: "t-reopen" })) === null,
  );
  check(
    "a wrong token re-opens nothing",
    (await invoke(Channels.previewReopenWeb, { threadId: "t-reopen", token: "guess" })) === false,
  );
  const reopenedOk = await invoke(Channels.previewReopenWeb, {
    threadId: "t-reopen",
    token: tokenA,
  });
  await delay(800);
  const reopenedState = await invoke(Channels.previewStateGet, { threadId: "t-reopen" });
  check(
    "the user's own web page re-opens by its token, at the shell's record, with a new token",
    reopenedOk === true &&
      reopenedState?.url === `http://site.example:${site.port}/mark-reopen` &&
      reopenedState?.webView !== undefined &&
      reopenedState.webView !== tokenA &&
      markSeen("/mark-reopen") === 2,
    { reopenedOk, state: reopenedState },
  );
  check(
    "a token re-opens once",
    (await invoke(Channels.previewReopenWeb, { threadId: "t-reopen", token: tokenA })) === false,
  );
  // The review's case: the user's web page, then the thread's agent takes the pane.
  await invoke(Channels.previewOpenWeb, {
    threadId: "t-agent-takes",
    url: `http://site.example:${site.port}/mark-user`,
  });
  await delay(800);
  const tokenB = (await invoke(Channels.previewStateGet, { threadId: "t-agent-takes" }))?.webView;
  const agentView = host.contentsFor("t-agent-takes", true);
  await agentView?.loadURL(`http://127.0.0.1:${dev.port}/`).catch(() => {});
  const agentState = await invoke(Channels.previewStateGet, { threadId: "t-agent-takes" });
  check(
    "the agent's page carries no web token",
    tokenB !== undefined && agentState?.webView === undefined && agentView?.session === local,
    agentState,
  );
  check(
    "the old token re-opens nothing while the agent's page is open",
    (await invoke(Channels.previewReopenWeb, { threadId: "t-agent-takes", token: tokenB })) ===
      false,
  );
  await evictAll("t-evict-b");
  const userSeen = markSeen("/mark-user");
  check(
    "nor after the agent's page was closed for newer threads', and the site sees nothing",
    (await invoke(Channels.previewReopenWeb, { threadId: "t-agent-takes", token: tokenB })) ===
      false && markSeen("/mark-user") === userSeen,
    { userSeen },
  );
  // The control: the same page in a session without the policy reaches both, so the probe is real.
  const controlSession = session.fromPartition("fixture-control");
  await controlSession.setProxy({ mode: "direct" });
  const control = new WebContentsView({
    webPreferences: { session: controlSession, sandbox: true },
  });
  control.webContents.setBackgroundThrottling(false);
  await control.webContents.loadURL(`http://127.0.0.1:${site.port}/rtc-control`).catch(() => {});
  const controlTitle = await rtcDone(control.webContents);
  check(
    "control: without the policy, the same probe reaches the STUN and TURN listeners",
    controlTitle === "rtc-done" && rtc.packets.length > 0 && rtc.connections.length > 0,
    { title: controlTitle, packets: rtc.packets.length, connections: rtc.connections.length },
  );
  control.webContents.close();
  win.destroy();
  rtc.close();
  proxyServer.close();
  lan.server.close();
  unusedServer.close();

  process.stdout.write(`${JSON.stringify({ type: "fixture.result", results, failures })}\n`);
  for (const listening of [gram, dev, site]) listening.server.close();
  app.quit();
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ type: "fixture.result", results, failures: [...failures, String(error?.stack ?? error)] })}\n`,
  );
  app.exit(1);
});
