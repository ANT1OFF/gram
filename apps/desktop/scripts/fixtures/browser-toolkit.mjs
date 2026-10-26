// Disposable native fixture for the browser toolkit. No Gram store, installed app, provider CLI or
// personal browser: one owned page on loopback, shown in a window whose menu has an accelerator a
// synthetic key must never reach.
import { app, BrowserWindow, Menu, session, WebContentsView } from "electron";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import {
  createAgentPanes,
  decodeFrame,
  servePaneMessage,
} from "../../../../packages/shell/src/modules/agent-browser/main.ts";
import { createBrowseHostList } from "../../../../packages/shell/src/core/browse-rules.ts";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const html = `<!doctype html><title>Browser toolkit fixture</title>
<meta name="viewport" content="width=device-width">
<style>
:root{color-scheme:light dark;--bg:#f8f7f4;--fg:#243039;--card:#fff;--accent:#cbe8da}
@media (prefers-color-scheme:dark){:root{--bg:#1d232a;--fg:#e8eef2;--card:#2a323b;--accent:#2f6b52}}
body{font:16px system-ui;background:var(--bg);color:var(--fg);margin:0;padding:24px}
h1{font-size:24px;margin:0 0 12px}
.row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-bottom:16px}
.box{background:var(--card);border:2px solid var(--fg);border-radius:8px;padding:12px;min-width:120px}
#menu{display:none;margin-top:8px}#hover:hover #menu,#hover.open #menu{display:block}
#zone{min-height:64px;min-width:200px}#zone.over{background:var(--accent)}
#status{font-weight:600}
#list li{padding:6px 0}
</style>
<h1>Browser toolkit</h1>
<p id="status" role="status">Ready</p>
<p id="env">Environment</p>
<div class="row">
  <div id="hover" class="box" role="button" aria-haspopup="menu" tabindex="0">Hover for menu<div id="menu" role="menu"><div role="menuitem">Rename</div><div role="menuitem">Archive</div></div></div>
  <button id="dbl" class="box">Double or right click</button>
  <div id="card" class="box" role="button" draggable="true">Drag this card</div>
  <div id="zone" class="box" role="region" aria-label="Drop zone">Drop zone</div>
</div>
<div class="row">
  <label class="box">Volume <input id="volume" type="range" min="0" max="100" value="10" aria-label="Volume"></label>
  <label class="box">Count <input id="count" aria-label="Count" value="0"></label>
  <button id="later" class="box">Finish later</button>
</div>
<ol id="list">${Array.from({ length: 60 }, (_, i) => `<li>Row ${i + 1}</li>`).join("")}<li id="bottom"><button>Bottom action</button></li></ol>
<script>
const status=document.getElementById('status'),env=document.getElementById('env');
const say=(text)=>{status.textContent=text};
const describe=()=>{env.textContent='Width '+innerWidth+' · scheme '+(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')+' · touch '+navigator.maxTouchPoints+' · '+(/Android/.test(navigator.userAgent)?'mobile agent':'desktop agent')};
describe();addEventListener('resize',describe);matchMedia('(prefers-color-scheme: dark)').addEventListener('change',describe);
document.getElementById('hover').addEventListener('mouseenter',()=>say('Menu open'));
const dbl=document.getElementById('dbl');
dbl.addEventListener('dblclick',()=>say('Double-clicked'));
dbl.addEventListener('contextmenu',(e)=>{e.preventDefault();say('Context menu')});
const card=document.getElementById('card'),zone=document.getElementById('zone');
card.addEventListener('dragstart',(e)=>{e.dataTransfer.setData('text/plain','card')});
zone.addEventListener('dragover',(e)=>{e.preventDefault();zone.classList.add('over')});
zone.addEventListener('drop',(e)=>{e.preventDefault();zone.textContent='Dropped '+e.dataTransfer.getData('text/plain');say('Dropped')});
document.getElementById('volume').addEventListener('input',(e)=>say('Volume '+e.target.value));
const count=document.getElementById('count');
count.addEventListener('keydown',(e)=>{if(e.key==='ArrowUp'){e.preventDefault();count.value=String(Number(count.value)+1)}});
addEventListener('keydown',(e)=>{if(e.metaKey&&e.key==='k'){e.preventDefault();say('Palette opened')}});
document.getElementById('later').addEventListener('click',()=>{say('Working');setTimeout(()=>say('Finished'),1500)});
addEventListener('scroll',()=>{if(scrollY>0)env.dataset.scrolled='yes';document.title='Browser toolkit · scrolled '+Math.round(scrollY)},{passive:true});
document.querySelector('#bottom button').addEventListener('click',()=>say('Bottom clicked'));
</script>`;

async function main() {
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");
  // `/desktop-only` leaves out the viewport meta, as a page never made for phones does.
  const server = createServer((req, res) =>
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        req.url === "/desktop-only"
          ? html.replace('<meta name="viewport" content="width=device-width">', "")
          : html,
      ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  // An app accelerator the agent's keys must not reach: synthetic input stays in the page.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Fixture",
        submenu: [
          {
            label: "Accelerator",
            accelerator: "CommandOrControl+Shift+9",
            click: () => send({ type: "fixture.accelerator" }),
          },
        ],
      },
    ]),
  );
  const profile = session.fromPartition("browser-toolkit-owned-fixture");
  profile.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  profile.setPermissionCheckHandler(() => false);
  profile.on("will-download", (event) => event.preventDefault());
  // The fixture's own page, and a dev server the harness starts on this computer's loopback.
  profile.webRequest.onBeforeRequest((details, answer) => {
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(details.url);
    if (details.url !== "about:blank" && !details.url.startsWith(`${origin}/`) && !loopback)
      return answer({ cancel: true });
    answer({ cancel: false });
  });
  const window = new BrowserWindow({ width: 820, height: 700, show: true, title: "Fixture" });
  const views = new Map();
  let userInputs = 0;
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
          // As the Preview pane does: input the agent didn't send takes the page over.
          view.webContents.on("before-input-event", (_event, input) => {
            if (input.type === "keyDown") {
              userInputs += 1;
              panes.userInput(view.webContents);
            }
          });
          view.webContents.on("before-mouse-event", (_event, mouse) => {
            if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
              panes.userInput(view.webContents);
          });
          window.contentView.addChildView(view);
          views.set(threadId, view);
        }
        return views.get(threadId)?.webContents;
      },
    },
    decodeFrame,
    resolveHost: () => {
      throw new Error("No external DNS in the fixture");
    },
    log: { warn: () => {}, info: () => {} },
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "fixture.stop") {
      app.quit();
      return;
    }
    if (message.type === "fixture.driver") {
      send({
        type: "fixture.response",
        id: message.id,
        driver: panes.driverOf(message.threadId),
        action: panes.actionOf(message.threadId),
        recording: panes.recordingOf(message.threadId),
        keyEvents: userInputs,
      });
      return;
    }
    servePaneMessage(message, panes, send);
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
