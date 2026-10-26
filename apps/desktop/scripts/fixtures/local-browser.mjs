// Disposable native fixture. No Gram store, installed app, provider CLI or personal browser.
import { app, session, WebContentsView } from "electron";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import {
  createAgentPanes,
  servePaneMessage,
} from "../../../../packages/shell/src/modules/agent-browser/main.ts";
import { createBrowseHostList } from "../../../../packages/shell/src/core/browse-rules.ts";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function main() {
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");
  const html = `<!doctype html><title>Local option fixture</title>
<style>body{font:20px system-ui;background:#f8f7f4;color:#243039;padding:48px}h1{font-size:32px}.box{padding:20px;border:2px solid #243039;width:360px;border-radius:8px}ul{background:white;padding:16px;list-style:none}li{padding:12px}[aria-selected=true]{background:#cbe8da}p{margin-top:32px}</style>
<h1>Local project picker</h1><p>Use the arrow keys to choose a project.</p>
<div id="picker" class="box" role="combobox" aria-label="Project" aria-expanded="false" tabindex="0">Choose a project</div>
<ul id="options" role="listbox" hidden><li role="option">Amber</li><li role="option">Teal</li><li role="option">Violet</li></ul>
<p id="status" role="status">Selected: none</p>
<script>
const picker=document.getElementById('picker'),options=document.getElementById('options'),status=document.getElementById('status');
let active=-1;
function show(open){options.hidden=!open;picker.setAttribute('aria-expanded',String(open));}
picker.onclick=()=>show(true);
if(location.pathname==='/focus-away'){
 const decoy=document.createElement('button');decoy.textContent='Another control';document.body.append(decoy);
 picker.addEventListener('focus',()=>decoy.focus());
 decoy.addEventListener('keydown',()=>status.textContent='Wrong target received a key');
}
picker.onkeydown=(event)=>{
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){
  event.preventDefault();show(true);active=Math.max(0,Math.min(2,active+(event.key==='ArrowDown'?1:-1)));
  [...options.children].forEach((option,index)=>option.setAttribute('aria-selected',String(index===active)));
 }
 if(event.key==='Enter'&&active>=0){event.preventDefault();status.textContent='Selected: '+options.children[active].textContent;show(false);}
 if(event.key==='Escape'){event.preventDefault();show(false);}
};
</script>`;
  const server = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(html),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  const profile = session.fromPartition("local-browser-owned-fixture");
  profile.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  profile.setPermissionCheckHandler(() => false);
  profile.on("will-download", (event) => event.preventDefault());
  const views = new Map();
  let gate;
  const dispatches = [];
  const panes = createAgentPanes({
    hosts: createBrowseHostList({ load: () => [], save: () => {}, changed: () => {} }),
    views: {
      contentsFor: (threadId, create) => {
        if (!views.has(threadId) && create) {
          const view = new WebContentsView({
            webPreferences: {
              session: profile,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          });
          view.setBounds({ x: 0, y: 0, width: 800, height: 650 });
          view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          const original = view.webContents.debugger.sendCommand.bind(view.webContents.debugger);
          view.webContents.debugger.sendCommand = async (method, params) => {
            if (gate?.method === method) {
              const waiting = gate;
              gate = undefined;
              send({ type: "fixture.paused", id: waiting.id });
              await waiting.wait;
            }
            if (method.startsWith("Input.") || method === "DOM.focus") dispatches.push(method);
            return original(method, params);
          };
          views.set(threadId, view);
        }
        return views.get(threadId)?.webContents;
      },
    },
    resolveHost: () => {
      throw new Error("No external DNS in the fixture");
    },
    log: { warn: () => {}, info: () => {} },
  });
  profile.webRequest.onBeforeRequest((details, answer) => {
    if (details.url !== "about:blank" && !details.url.startsWith(`${origin}/`))
      return answer({ cancel: true });
    answer({ cancel: false });
  });
  const releases = new Map();
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "fixture.stop") {
      app.quit();
      return;
    }
    if (message.type === "fixture.pause") {
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      releases.set(message.id, release);
      gate = { method: message.method, id: message.id, wait };
      send({ type: "fixture.response", id: message.id });
      return;
    }
    if (message.type === "fixture.release") {
      releases.get(message.id)?.();
      releases.delete(message.id);
      return;
    }
    if (message.type === "fixture.replace") {
      void views
        .get(message.threadId)
        .webContents.loadURL(`${origin}/replacement`)
        .then(() => send({ type: "fixture.response", id: message.id }));
      return;
    }
    if (message.type === "fixture.dispatches") {
      send({ type: "fixture.response", id: message.id, dispatches: [...dispatches] });
      return;
    }
    if (message.type === "fixture.takeOver") {
      panes.takeOver(message.threadId);
      send({ type: "fixture.response", id: message.id });
      return;
    }
    if (message.type === "fixture.handBack") {
      panes.handBack(message.threadId);
      send({ type: "fixture.response", id: message.id });
      return;
    }
    if (message.type === "fixture.close") {
      panes.closed(message.threadId);
      views.get(message.threadId)?.webContents.close();
      views.delete(message.threadId);
      send({ type: "fixture.response", id: message.id });
      return;
    }
    servePaneMessage(message, panes, send);
    if (message.type === "pane.cancel") send({ type: "fixture.cancelled", id: message.id });
  });
  app.on("will-quit", () => {
    for (const [id, view] of views) {
      panes.closed(id);
      view.webContents.close();
    }
    server.close();
  });
  send({
    type: "fixture.ready",
    origin,
    electron: process.versions.electron,
    node: process.versions.node,
  });
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
