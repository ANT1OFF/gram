// Invented provider protocols for speed tests. No credentials, recordings or network access.
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
const claude = process.env.GRAM_SPEED_AGENT === "claude";
const record = (msg) => fs.appendFileSync(process.env.GRAM_SPEED_LOG, JSON.stringify(msg) + "\n");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const flag = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1)
  ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes("--version")) { console.log(claude ? "2.1.292 (Claude Code)" : "codex-cli 0.159.2"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" })); process.exit(0); }
const settings = JSON.parse(flag("--settings") ?? '{}');
let fast = settings.fastMode ?? true; // Deliberate pre-existing CLI preference: Standard must override it.
let model = flag("--model") ?? "fixture-fast";
const session = randomUUID();
let threadId = session, turnId;
const state = () => fast ? "on" : "off";
const models = claude ? [
  { value: "fixture-fast", resolvedModel: "fixture-wire-fast", displayName: "Synthetic Fast model", description: "", supportsEffort: true, supportedEffortLevels: ["high"], supportsFastMode: true },
  { value: "fixture-standard", displayName: "Synthetic Standard model", description: "", supportsFastMode: false },
] : [
  { id: "fixture-fast", model: "fixture-fast", displayName: "Synthetic Fast model", description: "", hidden: false, isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "Synthetic Fast" }], additionalSpeedTiers: [], supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "fixture-standard", model: "fixture-standard", displayName: "Synthetic Standard model", description: "", hidden: false, isDefault: false, serviceTiers: [], additionalSpeedTiers: ["fast"], supportedReasoningEfforts: [] },
];
record({ launch: args, cwd: process.cwd() });
const envelope = () => ({ session_id: session, uuid: randomUUID() });
const notify = (method, params) => send({ method, params: { threadId, ...params } });
const turn = (status) => ({ id: turnId, status, items: [], error: null });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line); record(msg);
  if (claude) {
    if (msg.type === "control_request") {
      const req = msg.request;
      if (req.subtype === "set_model") model = req.model;
      if (req.subtype === "apply_flag_settings" && typeof req.settings.fastMode === "boolean") fast = req.settings.fastMode;
      let response = {};
      if (req.subtype === "initialize") response = { models, commands: [], agents: [], account: {}, fast_mode_state: state() };
      if (req.subtype === "list_models") response = { models };
      send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
    } else if (msg.type === "user") {
      const text = typeof msg.message.content === "string" ? msg.message.content : msg.message.content[0].text;
      const fallback = text === "fallback";
      send({ type: "system", subtype: "init", model, tools: [], mcp_servers: [], apiKeySource: "none", permissionMode: "default", slash_commands: [], fast_mode_state: fallback ? "cooldown" : state(), ...envelope() });
      send({ type: "result", subtype: "success", is_error: false, result: "Synthetic speed reply", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, terminal_reason: "completed", fast_mode_state: fallback ? "cooldown" : state(), ...envelope() });
      send({ type: "system", subtype: "session_state_changed", state: "idle", ...envelope() });
    }
  } else {
    if (msg.id === undefined) return;
    const p = msg.params ?? {};
    const respond = (result) => send({ id: msg.id, result });
    switch (msg.method) {
      case "initialize": respond({ userAgent: "synthetic", platformFamily: "unix", platformOs: process.platform }); break;
      case "account/read": respond({ account: { type: "chatgpt", email: "speed@example.invalid", planType: "plus" }, requiresOpenaiAuth: true }); break;
      case "model/list": respond({ data: models, nextCursor: null }); break;
      case "thread/start": case "thread/resume": case "thread/fork":
        threadId = msg.method === "thread/resume" ? p.threadId : randomUUID();
        if ("serviceTier" in p) fast = p.serviceTier !== "default";
        model = p.model ?? model;
        respond({ thread: { id: threadId, cwd: p.cwd, turns: [] }, model, serviceTier: fast ? "priority" : "default" }); break;
      case "skills/list": respond({ data: [] }); break;
      case "turn/start":
        if (p.input[0].text === "refuse") { send({ id: msg.id, error: { code: -32000, message: "Synthetic rejected send" } }); break; }
        if ("serviceTier" in p) fast = p.serviceTier !== "default";
        turnId = randomUUID();
        notify("thread/settings/updated", { threadSettings: { model, serviceTier: fast ? "priority" : "default" } });
        notify("turn/started", { turn: turn("inProgress") });
        respond({ turn: turn("inProgress") });
        notify("turn/completed", { turn: turn("completed") }); break;
      default: respond({});
    }
  }
});
