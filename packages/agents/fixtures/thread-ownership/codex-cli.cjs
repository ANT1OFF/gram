// Invented stdio app-server. All ownership files and child PIDs belong to this fixture.
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.162.1");
  process.exit(0);
}
const home = process.env.CODEX_HOME;
fs.mkdirSync(home, { recursive: true });
const log = (msg) => fs.appendFileSync(process.env.GRAM_OWNER_LOG, JSON.stringify({ pid: process.pid, home, msg }) + "\n");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const loaded = new Set();
const unsubscribed = new Set();
const waiters = new Map();
let n = 0;
let pendingResume;
let resumeSeen;
let holdResume = false;
let holdAllOpens = false;
const file = (id) => path.join(home, `invented-writer-${id}.json`);
const close = (id) => {
  if (loaded.delete(id)) fs.unlinkSync(file(id));
  log({ released: id });
  send({ method: "thread/closed", params: { threadId: id } });
};
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => {
  for (const id of loaded) fs.unlinkSync(file(id));
});
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.id === undefined) return;
  const p = msg.params ?? {};
  const respond = (result) => send({ id: msg.id, result });
  const error = (message) => send({ id: msg.id, error: { code: -32000, message } });
  switch (msg.method) {
    case "initialize": respond({ userAgent: "invented", platformFamily: "unix", platformOs: "test" }); break;
    case "config/read": respond({ config: { mcp_servers: { alpha: { command: "invented" } } }, origins: {} }); break;
    case "mcpServerStatus/list": respond({ data: [{ name: "alpha", runtimeStatus: "connected", pluginId: null }], nextCursor: null }); break;
    case "skills/list": respond({ data: [] }); break;
    case "thread/start":
    case "thread/resume":
    case "thread/fork": {
      const id = msg.method === "thread/resume" ? p.threadId : `invented-${process.pid}-${++n}`;
      if (fs.existsSync(file(id))) {
        const owner = JSON.parse(fs.readFileSync(file(id), "utf8")).pid;
        if (owner !== process.pid) { error(`thread ${id} already has an active writer`); break; }
      }
      fs.writeFileSync(file(id), JSON.stringify({ pid: process.pid }));
      loaded.add(id);
      log({ opened: id });
      const result = { thread: { id, cwd: p.cwd, turns: [] }, model: p.model ?? "invented-model" };
      if (holdAllOpens || (msg.method === "thread/resume" && holdResume)) {
        pendingResume = () => respond(result);
        resumeSeen?.();
        resumeSeen = undefined;
      } else respond(result);
      break;
    }
    case "thread/unsubscribe": {
      unsubscribed.add(p.threadId);
      const modePath = path.join(home, "invented-close-mode");
      const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8") : "immediate";
      if (mode === "error") error("Invented unsubscribe failure");
      else if (mode !== "no-reply") respond({ status: ["notLoaded", "notSubscribed", "unknown"].includes(mode) ? mode : "unsubscribed" });
      for (const reply of waiters.get(p.threadId) ?? []) reply();
      waiters.delete(p.threadId);
      if (mode === "persistence-failure" || mode === "silent-persistence-failure") {
        // Pinned shutdown can end the runtime while the shared recorder retains its writer.
        // Unsubscribing can also suppress Core error delivery; silence is no success proof.
        if (mode === "persistence-failure") send({ method: "error", params: {
          threadId: p.threadId, turnId: null, willRetry: false,
          error: { message: "Invented persistence shutdown failure", codexErrorInfo: null, additionalDetails: null },
        } });
        log({ persistenceFailed: p.threadId });
        send({ method: "thread/closed", params: { threadId: p.threadId } });
      }
      if (mode === "immediate") close(p.threadId);
      if (mode === "exit") process.stdout.write("", () => process.exit(0));
      break;
    }
    case "thread/read": {
      // Test controls are confined to this invented child, carried over a typed ordinary RPC.
      const [action, id] = p.threadId.split(":");
      if (action === "await-unsubscribe" && !unsubscribed.has(id)) {
        const replies = waiters.get(id) ?? [];
        replies.push(() => respond({}));
        waiters.set(id, replies);
        break;
      }
      if (action === "hold-open") holdAllOpens = true;
      if (action === "hold-resume") holdResume = true;
      if (action === "await-resume" && pendingResume === undefined) { resumeSeen = () => respond({}); break; }
      if (action === "release-resume") { pendingResume?.(); pendingResume = undefined; holdResume = false; }
      if (action === "close") close(id);
      if (action === "stale") send({ method: "thread/closed", params: { threadId: id } });
      if (action === "exit") { process.stdout.write("", () => process.exit(0)); break; }
      respond({});
      break;
    }
    case "turn/start": {
      const turn = { id: `turn-${++n}`, status: "completed", items: [], error: null };
      respond({ turn });
      send({ method: "turn/completed", params: { threadId: p.threadId, turn } });
      break;
    }
    default: respond({});
  }
});
