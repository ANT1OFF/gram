// Invented Codex app-server. Stateful JSON-RPC over real child stdio; no provider calls.
const fs = require("node:fs");
const args = process.argv.slice(2);
const apiEnvPresent = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].some((key) => !!process.env[key]);
const otherHarnessPresent = fs.existsSync(require("node:path").join(require("node:path").dirname(process.argv[1]), "claude"));
const subscriptionAuthPresent = !!process.env.GRAM_FIXTURE_AUTH && fs.existsSync(process.env.GRAM_FIXTURE_AUTH);
if (process.env.GRAM_FIXTURE_SUBSCRIPTION_ONLY === "1" && (apiEnvPresent || otherHarnessPresent || !subscriptionAuthPresent)) {
  console.error("Subscription-only fixture isolation failed");
  process.exit(10);
}
if (args.includes("--version")) {
  console.log("codex-cli 0.162.1");
  process.exit(0);
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const record = (msg) =>
  fs.appendFileSync(process.env.GRAM_FIXTURE_LOG, JSON.stringify({ pid: process.pid, msg }) + "\n");
record({ launch: args, home: process.env.CODEX_HOME, apiEnvPresent, otherHarnessPresent, subscriptionAuthPresent });
let threadId,
  turnId,
  threadConfig,
  n = 0;
const storePath = require("node:path").join(process.env.CODEX_HOME, "fixture-threads.json");
const stored = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {};
const notify = (method, params) => send({ method, params: { threadId, ...params } });
const turn = (status) => ({ id: turnId, status, items: [], error: null });
const finish = (status = "completed") => {
  notify("turn/completed", { turn: turn(status) });
  notify("thread/status/changed", { status: { type: "idle" } });
};
const text = (value) => {
  const item = { type: "agentMessage", id: `text-${n}`, text: "", phase: "final_answer" };
  notify("item/started", { turnId, item });
  for (const delta of [value.slice(0, 4), value.slice(4)])
    notify("item/agentMessage/delta", { turnId, itemId: item.id, delta });
  notify("item/completed", { turnId, item: { ...item, text: value } });
};
const command = (status) => ({
  type: "commandExecution", id: "synthetic-tool", command: "echo synthetic", cwd: process.cwd(),
  commandActions: [], status, aggregatedOutput: null, exitCode: null, durationMs: null,
});
const configuredSearch = () => {
  const config = require("node:path").join(process.env.CODEX_HOME, "config.toml");
  const mode = fs.existsSync(config) ? /web_search\s*=\s*"(\w+)"/.exec(fs.readFileSync(config, "utf8"))?.[1] : undefined;
  return args.includes('web_search="disabled"') ? "disabled" : (threadConfig?.web_search ?? mode ?? "cached");
};
// Synthetic Dream turns exercise the real bounded MCP bridge, never native filesystem tools.
const dreamTools = async () => {
  const endpoint = threadConfig.mcp_servers.gram;
  let id = 1;
  const rpc = async (method, params, allowError = false) => {
    const response = await fetch(endpoint.url, { method: "POST", headers: { ...endpoint.http_headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
    const reply = await response.json();
    record({ dreamBridge: method, params, reply });
    if (!response.ok || (reply.error && !allowError)) throw new Error("Synthetic bridge protocol failed");
    return reply.error ? { isError: true } : reply.result;
  };
  const call = async (name, arguments_) => {
    const result = await rpc("tools/call", { name, arguments: arguments_ });
    if (result.isError) throw new Error(`Synthetic ${name} failed`);
    return result.content[0].text;
  };
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic-codex", version: "0.162.1" } });
  const tools = await rpc("tools/list", {});
  record({ dreamToolNames: tools.tools.map((tool) => tool.name) });
  await call("dream_list", { path: "input/memory" });
  const memory = await call("dream_read", { path: "input/memory/MEMORY.md" });
  await call("dream_search", { path: "input/memory/MEMORY.md", text: "Memory" });
  await call("dream_write", { path: "work/note.md", content: "candidate" });
  await call("dream_edit", { path: "work/note.md", oldText: "candidate", newText: "reviewed" });
  await call("dream_delete", { path: "work/note.md" });
  for (const [name, arguments_] of [
    ["dream_write", { path: "input/memory/MEMORY.md", content: "evil" }],
    ["dream_read", { path: "../outside.md" }],
    ["memory_write", { path: "MEMORY.md", content: "evil" }],
  ]) {
    const result = await rpc("tools/call", { name, arguments: arguments_ }, true);
    if (!result.isError) throw new Error("Synthetic bounded denial failed");
  }
  await call("dream_write", { path: "output/MEMORY.md", content: memory + "\n2026-10-10: candidate from synthetic session.\n" });
  await call("dream_write", { path: "output/REPORT.md", content: "# Merged\nRetained snapshot.\n# Dropped, and why\nNone.\n# New, with sources\nCandidate from synthetic session.\n# Unresolved\nNone.\n" });
};
let approvalId, dreamApproval = false;
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const msg = JSON.parse(line);
    record(msg);
    if (!msg.method) {
      if (msg.id === approvalId) {
        notify("serverRequest/resolved", { requestId: approvalId });
        approvalId = undefined;
        notify("item/completed", { turnId, item: command(msg.result.decision === "accept" ? "completed" : "declined") });
        if (dreamApproval) {
          dreamApproval = false;
          dreamTools().then(() => { text("done"); finish(); }, (error) => { record({ dreamFailure: error.message }); text("Synthetic bridge failure"); finish("failed"); });
        } else {
          text(msg.result.decision === "accept" ? "Approved." : "Rejected.");
          finish();
        }
      }
      return;
    }
    if (msg.id === undefined) return;
    const respond = (result) => send({ id: msg.id, result });
    const p = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        if (fs.existsSync(process.env.GRAM_FIXTURE_FAIL_START))
          send({ id: msg.id, error: { code: -32000, message: "Synthetic startup failure" } });
        else
          respond({ userAgent: "synthetic", platformFamily: "unix", platformOs: process.platform });
        break;
      case "account/read":
        respond({
          account: !subscriptionAuthPresent || fs.existsSync(process.env.GRAM_FIXTURE_SIGNED_OUT)
            ? null
            : { type: "chatgpt", email: "developer@example.invalid", planType: "plus" },
          requiresOpenaiAuth: true,
        });
        break;
      case "config/read":
        respond({
          config: { mcp_servers: { alpha: { command: "synthetic-mcp" } } },
          origins: {},
        });
        break;
      case "mcpServerStatus/list":
        respond({
          data: [
            {
              name: "alpha",
              runtimeStatus:
                threadConfig?.mcp_servers?.alpha?.enabled === false ? "disabled" : "connected",
              pluginId: null,
            },
            ...(threadConfig?.features?.plugins === false
              ? []
              : [{ name: "beta", runtimeStatus: "connected", pluginId: "fixture@synthetic" }]),
            ...(threadConfig?.features?.apps === false
              ? []
              : [{ name: "codex_apps", runtimeStatus: "connected", pluginId: null }]),
          ],
          nextCursor: null,
        });
        break;
      case "model/list":
        respond({
          data: [
            {
              id: "fixture-model",
              model: "fixture-model",
              displayName: "Synthetic model",
              description: "",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            },
          ],
          nextCursor: null,
        });
        break;
      case "thread/start":
      case "thread/resume":
      case "thread/fork":
        if (msg.method !== "thread/start" && !stored[p.threadId]) {
          send({ id: msg.id, error: { code: -32000, message: "Synthetic thread not found" } });
          break;
        }
        threadId = msg.method === "thread/resume" ? p.threadId : `synthetic-${process.pid}-${++n}`;
        threadConfig = p.config;
        stored[threadId] = { cwd: p.cwd };
        fs.writeFileSync(storePath, JSON.stringify(stored));
        respond({
          thread: { id: threadId, cwd: p.cwd, turns: [] },
          model: p.model ?? "fixture-model",
        });
        break;
      case "thread/unsubscribe":
        respond({ status: "unsubscribed" });
        send({ method: "thread/closed", params: { threadId: p.threadId } });
        break;
      case "skills/list":
        respond({ data: [] });
        break;
      case "turn/start": {
        turnId = `turn-${++n}`;
        const prompt = p.input[0].text;
        if (prompt === "exit") {
          process.exit(9);
        }
        if (prompt === "refuse") {
          send({ id: msg.id, error: { code: -32000, message: "Synthetic refused turn" } });
          break;
        }
        // Notifications may precede the request's reply. This exposes cancellation races.
        notify("turn/started", { turn: turn("inProgress") });
        if (prompt !== "late") respond({ turn: turn("inProgress") });
        if (prompt === "wait") break;
        if (prompt.startsWith("Consolidate the long-term memory") && threadConfig?.mcp_servers?.gram) {
          // Native permission handshake only; the fixture never executes this command.
          dreamApproval = true;
          approvalId = 100 + n;
          notify("item/started", { turnId, item: command("inProgress") });
          send({ id: approvalId, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: "synthetic-tool", command: "echo synthetic", cwd: p.cwd, availableDecisions: ["accept", "decline"] } });
          break;
        }
        if (prompt === "reconnect")
          notify("error", {
            turnId,
            willRetry: true,
            error: {
              message: "Synthetic reconnect",
              codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
            },
          });
        if (["approve", "deny", "pending"].includes(prompt)) {
          notify("item/started", { turnId, item: command("inProgress") });
          approvalId = 100 + n;
          send({
            id: approvalId,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId,
              turnId,
              itemId: "synthetic-tool",
              kind: "command",
              command: "echo synthetic",
              cwd: p.cwd,
              availableDecisions: ["accept", "decline"],
            },
          });
        } else {
          if (["search", "open-page", "find-in-page"].includes(prompt) && configuredSearch() !== "disabled") {
            const url = "https://docs.example.invalid/synthetic";
            const action = prompt === "open-page" ? { type: "openPage", url }
              : prompt === "find-in-page" ? { type: "findInPage", url, pattern: "synthetic" }
              : { type: "search", query: "synthetic documentation", queries: null };
            const item = { type: "webSearch", id: `search-${n}`, query: "synthetic documentation", action, results: null };
            record({ webAction: action });
            notify("item/started", { turnId, item });
            notify("item/completed", { turnId, item });
          }
          text("Synthetic reply.");
          finish();
        }
        if (prompt === "late") {
          const path = process.env.GRAM_FIXTURE_RELEASE_REPLY;
          // Polled, not fs.watch: macOS's FSEvents can drop a directory event (about 1 in 1500
          // under parallel test load), which left this reply, and the test, waiting forever. A
          // release before, during or after the first check is seen by the next one.
          const replyIfReleased = () => {
            if (!fs.existsSync(path)) return;
            clearInterval(polling);
            respond({ turn: turn("inProgress") });
          };
          const polling = setInterval(replyIfReleased, 10);
          replyIfReleased();
        }
        break;
      }
      case "turn/interrupt":
        if (approvalId) {
          notify("serverRequest/resolved", { requestId: approvalId });
          approvalId = undefined;
        }
        respond({});
        finish("interrupted");
        break;
      case "turn/steer":
        respond({ turnId });
        break;
      default:
        send({
          id: msg.id,
          error: { code: -32601, message: `Unexpected synthetic method ${msg.method}` },
        });
    }
  });
