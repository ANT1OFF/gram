// Invented Claude stream-json CLI. No recordings, network calls, or account data.
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
const apiEnvPresent = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].some((key) => !!process.env[key]);
const otherHarnessPresent = fs.existsSync(require("node:path").join(require("node:path").dirname(process.argv[1]), "codex"));
const subscriptionAuthPresent = !!process.env.GRAM_FIXTURE_AUTH && fs.existsSync(process.env.GRAM_FIXTURE_AUTH);
if (process.env.GRAM_FIXTURE_SUBSCRIPTION_ONLY === "1" && (apiEnvPresent || otherHarnessPresent || !subscriptionAuthPresent)) {
  console.error("Subscription-only fixture isolation failed");
  process.exit(10);
}
const record = (msg) =>
  fs.appendFileSync(process.env.GRAM_FIXTURE_LOG, JSON.stringify({ pid: process.pid, msg }) + "\n");
if (args.includes("--version")) {
  console.log("2.1.292 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(
    JSON.stringify({
      loggedIn: subscriptionAuthPresent && !fs.existsSync(process.env.GRAM_FIXTURE_SIGNED_OUT),
      authMethod: "oauth_token",
      apiProvider: "firstParty",
    }),
  );
  process.exit(fs.existsSync(process.env.GRAM_FIXTURE_SIGNED_OUT) ? 1 : 0);
}
const flag = (name) =>
  args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1) ??
  (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = flag("--session-id") ?? flag("--resume");
let model = flag("--model") ?? "default";
const storePath = require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "fixture-sessions.json");
const stored = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {};
if (flag("--resume") && !stored[flag("--resume")]) {
  console.error("No conversation found");
  process.exit(1);
}
stored[sessionId] = { cwd: process.cwd() };
fs.writeFileSync(storePath, JSON.stringify(stored));
record({
  launch: args,
  cwd: process.cwd(),
  apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
  oauthPresent: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
  apiEnvPresent,
  otherHarnessPresent,
  subscriptionAuthPresent,
});
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const envelope = () => ({ session_id: sessionId, uuid: randomUUID() });
const state = (value) =>
  send({ type: "system", subtype: "session_state_changed", state: value, ...envelope() });
const finish = (reason = "completed", error) => {
  send({
    type: "result",
    subtype: "success",
    is_error: !!error,
    result: error ?? "",
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    terminal_reason: reason,
    usage: { input_tokens: 2, output_tokens: 2 },
    modelUsage: {},
    ...envelope(),
  });
  state("idle");
};
const text = (value) => {
  const message = {
    id: randomUUID(),
    type: "message",
    role: "assistant",
    model,
    content: [],
    usage: { input_tokens: 2, output_tokens: 2 },
  };
  send({
    type: "stream_event",
    event: { type: "message_start", message },
    parent_tool_use_id: null,
    ...envelope(),
  });
  send({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    parent_tool_use_id: null,
    ...envelope(),
  });
  for (const delta of [value.slice(0, 4), value.slice(4)])
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } },
      parent_tool_use_id: null,
      ...envelope(),
    });
  send({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
    parent_tool_use_id: null,
    ...envelope(),
  });
  send({
    type: "stream_event",
    event: { type: "message_stop" },
    parent_tool_use_id: null,
    ...envelope(),
  });
};
let permissionId;
let cancelledPermissionId;
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const msg = JSON.parse(line);
    record(msg);
    if (msg.type === "control_request") {
      const req = msg.request;
      if (req.subtype === "initialize" && fs.existsSync(process.env.GRAM_FIXTURE_FAIL_START)) {
        send({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: msg.request_id,
            error: "Synthetic startup failure",
          },
        });
        return;
      }
      if (req.subtype === "set_model") model = req.model;
      const response =
        req.subtype === "initialize"
          ? {
              commands: [],
              agents: [],
              models: [
                { value: "default", displayName: "Default", description: "Synthetic default" },
                { value: "fixture-small", displayName: "Small", description: "Synthetic small" },
              ],
              account: {},
            }
          : {};
      send({
        type: "control_response",
        response: { subtype: "success", request_id: msg.request_id, response },
      });
      if (req.subtype === "interrupt") {
        if (permissionId) {
          cancelledPermissionId = permissionId;
          send({ type: "control_cancel_request", request_id: permissionId });
          permissionId = undefined;
          // The SDK aborts canUseTool and sends its denial asynchronously. Consume that reply
          // before ending the synthetic turn so cancellation is quiescent at turnEnd.
        } else finish("aborted_tools");
      }
    } else if (msg.type === "user") {
      if (msg.message.content === "exit") {
        process.exit(9);
      }
      send({
        type: "system",
        subtype: "init",
        cwd: process.cwd(),
        model,
        tools: ["Bash"],
        skills: [],
        slash_commands: [],
        mcp_servers: [],
        apiKeySource: "none",
        permissionMode: "default",
        ...envelope(),
      });
      state("running");
      if (msg.message.content === "reconnect")
        send({
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 2,
          retry_delay_ms: 0,
          error_status: 503,
          ...envelope(),
        });
      if (msg.message.content === "wait") return;
      if (msg.message.content === "expired") {
        const error = "Login expired · Run /login to sign in again";
        send({
          type: "assistant",
          error: "unknown",
          parent_tool_use_id: null,
          message: {
            id: randomUUID(),
            role: "assistant",
            model,
            content: [{ type: "text", text: error }],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          ...envelope(),
        });
        finish("api_error", error);
        return;
      }
      if (["approve", "deny", "pending"].includes(msg.message.content)) {
        permissionId = randomUUID();
        send({
          type: "control_request",
          request_id: permissionId,
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            tool_use_id: "synthetic-tool",
            input: { command: "echo synthetic" },
            permission_suggestions: [],
          },
        });
      } else {
        text("Synthetic reply.");
        finish();
      }
    } else if (msg.type === "control_response" && msg.response.request_id === cancelledPermissionId) {
      cancelledPermissionId = undefined;
      finish("aborted_tools");
    } else if (msg.type === "control_response" && msg.response.request_id === permissionId) {
      permissionId = undefined;
      text(msg.response.response.behavior === "allow" ? "Approved." : "Rejected.");
      finish();
    }
  });
