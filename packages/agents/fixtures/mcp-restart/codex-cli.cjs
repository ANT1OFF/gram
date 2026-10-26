// Invented app-server with real owned stdio, per-child configuration and writer files.
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { console.log("codex-cli 0.162.1"); process.exit(0); }
const home = process.env.CODEX_HOME;
const log = (msg) => fs.appendFileSync(process.env.GRAM_RESTART_LOG, JSON.stringify({ pid: process.pid, msg }) + "\n");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const configFile = path.join(home, "invented-config.json");
const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
const config = readConfig();
log({ boot: { home: path.basename(home) === "gateway" ? "gateway" : "user", gatewayKeyPresent: process.env.LLM_API_KEY !== undefined } });
const loaded = new Set();
const background = new Map();
const turns = new Map();
const approvals = new Map();
const heldReplies = [];
const holdReply = (method, reply) => {
  if (!fs.existsSync(path.join(home, "invented-hold-rpc"))) { reply(); return; }
  heldReplies.push(reply); log({ heldRpc: method });
};
let n = 0;
const writer = (id) => path.join(home, `invented-writer-${id}`);
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => { log({ exited: true }); for (const child of background.values()) child.kill(); for (const id of loaded) fs.rmSync(writer(id), { force: true }); });
const complete = (id) => {
  const child = background.get(id); if (child) { child.kill(); background.delete(id); }
  const turn = turns.get(id);
  if (turn) send({ method: "turn/completed", params: { threadId: id, turn: { ...turn, status: "completed" } } });
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (!msg.method) {
    const id = approvals.get(msg.id);
    if (id) { approvals.delete(msg.id); complete(id); }
    return;
  }
  if (msg.id === undefined) return;
  const p = msg.params ?? {};
  const respond = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      if (fs.existsSync(path.join(home, "invented-refuse-start"))) send({ id: msg.id, error: { message: "Invented initialization failure" } }); else respond({});
      break;
    case "config/read": holdReply(msg.method, () => respond({ config: { mcp_servers: readConfig() }, origins: {} })); break;
    // Owned keyless metadata fixture; never consult a host account or credential store.
    case "account/read": respond({ account: null, requiresOpenaiAuth: false }); break;
    case "model/list": holdReply(msg.method, () => respond({ data: [], nextCursor: null })); break;
    case "thread/list": holdReply(msg.method, () => respond({ data: [], nextCursor: null })); break;
    case "config/batchWrite": {
      const next = readConfig();
      for (const edit of p.edits) {
        const name = edit.keyPath.split(".")[1];
        if (edit.value === null) delete next[name]; else next[name] = edit.value;
      }
      fs.writeFileSync(configFile, JSON.stringify(next));
      // Record the real request's live-refresh scope without simulating a provider crash.
      if (p.reloadUserConfig) log({ liveRefresh: [...loaded] });
      const outcomeFile = path.join(home, "invented-write-outcome");
      const outcome = fs.existsSync(outcomeFile) ? fs.readFileSync(outcomeFile, "utf8") : "ok";
      if (outcome === "error") send({ id: msg.id, error: { message: "Invented failure after persisted config write" } });
      else if (outcome !== "cancel") holdReply(msg.method, () => respond({}));
      break;
    }
    case "config/mcpServer/reload": log({ liveRefresh: [...loaded] }); respond({}); break;
    case "mcpServerStatus/list": respond({ data: Object.keys(config).map((name) => ({ name, runtimeStatus: "connected", pluginId: null })), nextCursor: null }); break;
    case "skills/list": respond({ data: [] }); break;
    case "thread/start":
    case "thread/resume": {
      const id = msg.method === "thread/resume" ? p.threadId : `synthetic-${process.pid}-${++n}`;
      if (fs.existsSync(writer(id)) && fs.readFileSync(writer(id), "utf8") !== String(process.pid)) {
        send({ id: msg.id, error: { message: "Invented active writer" } }); break;
      }
      loaded.add(id); fs.writeFileSync(writer(id), String(process.pid));
      log({ opened: id, servers: Object.keys(config) });
      respond({ thread: { id, cwd: p.cwd, turns: [] }, model: "synthetic-model" }); break;
    }
    case "thread/unsubscribe":
      respond({ status: "unsubscribed" });
      // Even a matching close never releases our writer until this exact child exits.
      send({ method: "thread/closed", params: { threadId: p.threadId } });
      break;
    case "turn/start": {
      const turn = { id: `turn-${++n}`, status: "inProgress", items: [], error: null };
      turns.set(p.threadId, turn); respond({ turn });
      send({ method: "turn/started", params: { threadId: p.threadId, turn } });
      const text = p.input?.find((v) => v.type === "text")?.text ?? "";
      const hold = process.env.GRAM_RESTART_EXACT_MARKERS === "1" ? text.startsWith("hold ") : text.includes("hold");
      if (hold) {
        const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: home, env: { HOME: home, PATH: process.env.PATH }, stdio: "ignore" });
        background.set(p.threadId, child); log({ backgroundPid: child.pid, threadId: p.threadId });
      }
      if (process.env.GRAM_RESTART_EXACT_MARKERS === "1" ? text.startsWith("approval ") : text.includes("approval")) {
        const id = `approval-${++n}`; approvals.set(id, p.threadId);
        send({ id, method: "item/commandExecution/requestApproval", params: { threadId: p.threadId, turnId: turn.id, itemId: `command-${n}`, command: "echo synthetic", cwd: p.cwd ?? home } });
      } else if (!hold) complete(p.threadId);
      break;
    }
    case "thread/read": {
      const [action, id] = p.threadId.split(":");
      if (action === "release-rpc") { for (const reply of heldReplies.splice(0)) reply(); }
      if (action === "complete") complete(id);
      if (action === "stream") {
        const params = { threadId: id, turnId: turns.get(id)?.id };
        send({ method: "item/started", params: { ...params, item: { type: "agentMessage", id: "synthetic-reply", text: "" } } });
        send({ method: "item/agentMessage/delta", params: { ...params, itemId: "synthetic-reply", delta: "still streaming" } });
        send({ method: "item/completed", params: { ...params, item: { type: "agentMessage", id: "synthetic-reply", text: "still streaming" } } });
      }
      if (action === "exit") { respond({}); process.stdout.write("", () => process.exit(0)); break; }
      respond({}); break;
    }
    case "turn/interrupt": complete(p.threadId); respond({}); break;
    default: respond({});
  }
});
