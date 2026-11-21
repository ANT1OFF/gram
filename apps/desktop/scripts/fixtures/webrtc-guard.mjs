// Disposable native fixture for the WebRTC guard (`preview/webrtc-guard.ts`) on the Preview tab's
// local pages. No Gram store, installed app, provider CLI or outside network. Every `.leak.test`
// name resolves to loopback, where a listener stands for a TURN server, so a lookup and connection
// WebRTC made for a name the page chose would be seen. Each probe tries a peer connection in the
// page, in a child the page makes by script at `about:blank` (which no preload reaches) and in an
// out-of-process frame; then again after something else detached the page's debugger.
import { app, session, WebContentsView } from "electron";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { Channels } from "../../../../packages/shell/src/channels.ts";
import { installPreview } from "../../../../packages/shell/src/modules/preview/main.ts";

const results = [];
const failures = [];
const check = (label, ok, detail) => {
  (ok ? results : failures).push(
    detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`,
  );
};

/** A peer connection to a TURN server named `tag`, in `w`, in a self-contained script. */
const tryRtc = (turnPort) => `const tryRtc = (w, tag) => {
  if (typeof w.RTCPeerConnection !== "function") return "none";
  try {
    const pc = new w.RTCPeerConnection({ iceServers: [{
      urls: "turn:" + tag + ".leak.test:${turnPort}?transport=tcp", username: "u", credential: "c",
    }] });
    pc.createDataChannel("probe");
    pc.createOffer().then((offer) => pc.setLocalDescription(offer));
    return "made";
  } catch (error) { return error.name; }
};`;

/** The page: its own try, an `about:blank` child's, and an out-of-process frame's. */
const probePage = (turnPort, childOrigin) => `<!doctype html><title>Probe</title><body><script>
${tryRtc(turnPort)}
const out = { top: tryRtc(window, "top") };
const blank = document.createElement("iframe");
document.body.append(blank);
out.blank = tryRtc(blank.contentWindow, "blank");
addEventListener("message", (event) => { out.oopif = event.data; });
const other = document.createElement("iframe");
other.src = "${childOrigin}/child";
document.body.append(other);
setTimeout(() => (document.title = "probe:" + JSON.stringify(out)), 3000);
</script>`;

const childPage = (turnPort) =>
  `<!doctype html><script>${tryRtc(turnPort)} parent.postMessage(tryRtc(window, "oopif"), "*");</script>`;

const NO_RTC = { top: "none", blank: "none", oopif: "none" };

async function main() {
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.leak.test 127.0.0.1");

  const turn = { connections: 0 };
  const turnServer = createTcpServer((socket) => {
    turn.connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => turnServer.listen(0, "127.0.0.1", resolve));
  const turnPort = turnServer.address().port;
  const dev = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      request.url === "/child"
        ? childPage(turnPort)
        : probePage(turnPort, `http://localhost:${dev.address().port}`),
    );
  });
  await new Promise((resolve) => dev.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${dev.address().port}/`;

  await app.whenReady();
  const handlers = new Map();
  const ipc = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, (arg, event) => handler(event, arg)),
  };
  const sender = { send: () => {}, isDestroyed: () => false, getZoomFactor: () => 1 };
  const invoke = (channel, arg) => handlers.get(channel)(arg, { sender });
  const host = installPreview(ipc, {
    openLink: async () => false,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  /** What `threadId`'s probe found, once it has said. */
  const probed = async (threadId) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await delay(100)) {
      const title = (await invoke(Channels.previewStateGet, { threadId }))?.title ?? "";
      if (title.startsWith("probe:")) return JSON.parse(title.slice("probe:".length));
    }
    return undefined;
  };

  const before = turn.connections;
  await invoke(Channels.previewOpen, { threadId: "t-probe", url });
  host.contentsOf("t-probe")?.setBackgroundThrottling(false);
  const first = await probed("t-probe");
  await delay(1500);
  check(
    "a local page has no WebRTC: not itself, not its about:blank child, not an out-of-process frame",
    JSON.stringify(first) === JSON.stringify(NO_RTC),
    first,
  );
  check("no TURN server it named was reached", turn.connections === before, turn.connections);

  // Something else detaches the page's debugger: the guard puts itself back before it loads more.
  const contents = host.contentsOf("t-probe");
  contents?.debugger.detach();
  await delay(500);
  check("the guard attached again", contents?.debugger.isAttached() === true);
  await contents?.loadURL(url).catch(() => {});
  const again = await probed("t-probe");
  await delay(1500);
  check(
    "after a detach, the page and its frames still have no WebRTC",
    JSON.stringify(again) === JSON.stringify(NO_RTC) && turn.connections === before,
    { again, connections: turn.connections - before },
  );

  // The control: the same page in a session without the guard reaches the listener.
  const control = new WebContentsView({
    webPreferences: { session: session.fromPartition("fixture-control"), sandbox: true },
  });
  control.webContents.setBackgroundThrottling(false);
  await control.webContents.loadURL(url).catch(() => {});
  let controlled;
  for (const end = Date.now() + 20_000; Date.now() < end; await delay(100)) {
    const title = control.webContents.getTitle();
    if (title.startsWith("probe:")) {
      controlled = JSON.parse(title.slice("probe:".length));
      break;
    }
  }
  await delay(1500);
  check(
    "control: without the guard, each frame makes one, and a TURN server it named is reached",
    controlled?.top === "made" &&
      controlled?.blank === "made" &&
      controlled?.oopif === "made" &&
      turn.connections > before,
    { controlled, connections: turn.connections - before },
  );
  control.webContents.close();

  process.stdout.write(`${JSON.stringify({ type: "fixture.result", results, failures })}\n`);
  dev.close();
  turnServer.close();
  app.quit();
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ type: "fixture.result", results, failures: [...failures, String(error?.stack ?? error)] })}\n`,
  );
  app.exit(1);
});
