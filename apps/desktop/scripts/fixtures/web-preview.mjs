// Disposable native fixture for the Preview tab's web session. No Gram store, installed app,
// provider CLI, personal browser or outside network: "site.example" and "rebind.example" are
// mapped to this fixture's own loopback listeners, and the web session's lookup is told what a
// real resolver would answer for each, a public address and a rebound loopback one.
import { app, session, webContents as allContents } from "electron";
import { createServer } from "node:http";

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

async function main() {
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");

  // Gram's own server: what a remote page must never reach, with or without its launch cookie.
  const gram = await listener((_request, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end("{}"),
  );
  // A dev server on loopback, the local session's.
  const dev = await listener((_request, response) =>
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        `<title>Dev app</title><a id="out" href="http://site.example:${site.port}/plain">Docs</a>`,
      ),
  );
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
    response.writeHead(200, { "content-type": "text/html" }).end(page(site.port));
  });
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    "MAP site.example 127.0.0.1, MAP rebind.example 127.0.0.1, MAP gram.localhost 127.0.0.1",
  );

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
  const host = installPreview(ipc, {
    openLink: async () => false,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    resolveWebHost: async (name) => ({
      endpoints: [
        { address: name === "rebind.example" ? "127.0.0.1" : "93.184.216.34", family: "ipv4" },
      ],
    }),
  });
  const T = "t-web";
  const state = () => invoke(Channels.previewStateGet, { threadId: T });
  const waitTitle = async (prefix, ms = 90_000) => {
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
      (await invoke(Channels.previewOpen, { threadId: T, url })) === false,
    );
  }

  // A remote page loads, in the web session, sandboxed, and reaches nothing of this computer.
  const siteUrl = `http://site.example:${site.port}/`;
  check(
    "opens a remote page",
    (await invoke(Channels.previewOpen, { threadId: T, url: siteUrl })) === true,
  );
  contentsAt(siteUrl)?.setBackgroundThrottling(false);
  const done = await waitTitle("done:");
  if (!done?.title?.startsWith("done:"))
    failures.push(
      `partial probes: ${await contentsAt(siteUrl)?.executeJavaScript("JSON.stringify(results)")}`,
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
    await invoke(Channels.previewOpen, {
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

  // A link off the user's local app opens in the web session, not in the local one.
  const U = "t-dev";
  await invoke(Channels.previewOpen, { threadId: U, url: `http://127.0.0.1:${dev.port}/` });
  const devPage = contentsAt(`http://127.0.0.1:${dev.port}/`);
  await devPage?.executeJavaScript(`document.getElementById("out").click()`, true);
  for (const end = Date.now() + 10_000; Date.now() < end; await delay(100)) {
    if ((await invoke(Channels.previewStateGet, { threadId: U }))?.title === "Plain") break;
  }
  const followed = contentsAt(`http://site.example:${site.port}/plain`);
  check(
    "a link off a local page opens in the web session",
    followed?.session === web && devPage?.isDestroyed() === true,
    followed?.getURL(),
  );
  check("the agent can't take that page either", host.contentsFor(U, false) === undefined);

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
