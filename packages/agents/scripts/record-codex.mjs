// Records `codex app-server` JSON-RPC streams against a scripted local Responses API. No gateway and
// no real key: CODEX_HOME is a temp dir, LLM_API_KEY is a dummy only the local server sees, and the
// fixtures are scrubbed of machine details. `CODEX_SCENARIOS=cx01-text,…` records a subset.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.env.CODEX_FIXTURES ?? new URL("../fixtures/codex/", import.meta.url).pathname;
const ONLY = process.env.CODEX_SCENARIOS?.split(",");
const DUMP_TOOLS = process.env.CODEX_DUMP_TOOLS;
const DUMMY_KEY = "gram-dummy-not-a-key";
mkdirSync(OUT, { recursive: true });
const cliVersion = execFileSync("codex", ["--version"]).toString().trim().split(" ").at(-1);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = {
  input_tokens: 42,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 3 },
  total_tokens: 49,
};

const message = (id, text) => [
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "message", role: "assistant", id: `msg_${id}`, content: [] },
  },
  ...text.match(/.{1,8}/g).map((delta) => ({
    type: "response.output_text.delta",
    item_id: `msg_${id}`,
    output_index: 1,
    content_index: 0,
    delta,
  })),
  {
    type: "response.output_item.done",
    output_index: 1,
    item: {
      type: "message",
      role: "assistant",
      id: `msg_${id}`,
      content: [{ type: "output_text", text }],
    },
  },
];
const reasoning = (id, text) => [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "reasoning", id: `rs_${id}`, summary: [] },
  },
  {
    type: "response.reasoning_summary_part.added",
    item_id: `rs_${id}`,
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: "" },
  },
  {
    type: "response.reasoning_summary_text.delta",
    item_id: `rs_${id}`,
    output_index: 0,
    summary_index: 0,
    delta: text,
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", id: `rs_${id}`, summary: [{ type: "summary_text", text }] },
  },
];
const created = (id) => ({ type: "response.created", response: { id } });
const done = (id) => ({ type: "response.completed", response: { id, usage } });
/** A plain text reply; a number in the list pauses the stream that long. */
const text =
  (answer, { think, pauseMs } = {}) =>
  (n) => [
    created(`resp_${n}`),
    ...(think ? reasoning(n, think) : []),
    ...message(n, answer).slice(0, 2),
    ...(pauseMs ? [pauseMs] : []),
    ...message(n, answer).slice(2),
    done(`resp_${n}`),
  ];

/** A minimal streamable-HTTP MCP server: records each request's authorization header. */
const mcpHandler = (mcpCalls) => (req, res, body) => {
  const msg = body ? JSON.parse(body) : undefined;
  mcpCalls.push({
    method: req.method,
    rpc: msg?.method,
    authorization: req.headers["authorization"],
  });
  if (req.method !== "POST") return res.writeHead(405).end();
  if (msg.id === undefined) return res.writeHead(202).end();
  const result =
    msg.method === "initialize"
      ? {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "gram", version: "0.0.0" },
        }
      : msg.method === "tools/list"
        ? {
            tools: [
              {
                name: "rename_thread",
                description: "Rename this thread.",
                inputSchema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                  required: ["title"],
                },
              },
            ],
          }
        : { content: [{ type: "text", text: "renamed" }] };
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
};

/**
 * `options.configToml(port)`: a `config.toml` written into the temp CODEX_HOME before codex starts.
 * `options.args`: more `app-server` arguments. A reply that returns `{ status, headers?, body }`
 * instead of events answers with that HTTP error.
 */
async function record(name, drive, replies, options = {}) {
  if (ONLY && !ONLY.includes(name)) return;
  const requests = [];
  const mcpCalls = [];
  const mcp = mcpHandler(mcpCalls);
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      if (req.url?.startsWith("/mcp")) return mcp(req, res, body);
      const parsed = body ? JSON.parse(body) : {};
      if (DUMP_TOOLS && n === 0) writeFileSync(DUMP_TOOLS, JSON.stringify(parsed.tools, null, 1));
      requests.push({
        tools: (parsed.tools ?? []).map((t) => t.name ?? t.type),
        input: (parsed.input ?? []).map((i) => i.type),
        outputs: (parsed.input ?? [])
          .filter((i) => i.type?.endsWith("_output"))
          .map((i) => JSON.stringify(i.output ?? i).slice(0, 2_000)),
      });
      const reply = replies[Math.min(n++, replies.length - 1)];
      const events = reply(n);
      if (!Array.isArray(events)) {
        res.writeHead(events.status, { "content-type": "application/json", ...events.headers });
        return res.end(JSON.stringify(events.body));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        if (res.destroyed) return;
        if (typeof event === "number") await sleep(event);
        else res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-home-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-project-")));
  if (options.configToml) writeFileSync(join(home, "config.toml"), options.configToml(port));
  const child = spawn(
    "codex",
    [
      "app-server",
      "-c",
      "model_provider=gram",
      "-c",
      'model_providers.gram.name="Gram"',
      "-c",
      `model_providers.gram.base_url="http://127.0.0.1:${port}/v1"`,
      "-c",
      'model_providers.gram.env_key="LLM_API_KEY"',
      "-c",
      'model_providers.gram.wire_api="responses"',
      "-c",
      'model="gpt-5.5"',
      ...(options.args ?? []),
      ...(process.env.CODEX_EXTRA_ARGS?.split(" ").filter(Boolean) ?? []),
    ],
    {
      env: { ...process.env, CODEX_HOME: home, LLM_API_KEY: DUMMY_KEY },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const messages = [];
  const waiters = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const entry = { dir: "in", msg: JSON.parse(line) };
      messages.push(entry);
      const waiter = waiters.find((w) => w.match(entry.msg));
      if (waiter) {
        entry.claimed = true;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(entry.msg);
      }
    }
  });
  let id = 0;
  const api = {
    cwd,
    port,
    mcpCalls,
    requests,
    sleep,
    send: (msg) => {
      messages.push({ dir: "out", msg });
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    request: (method, params) => {
      const rid = ++id;
      api.send({ id: rid, method, params });
      return api.wait((m) => m.id === rid && m.method === undefined);
    },
    respond: (rid, result) => api.send({ id: rid, result }),
    wait: (match, ms = 20_000) =>
      new Promise((resolve, reject) => {
        const found = messages.find((m) => m.dir === "in" && m.claimed !== true && match(m.msg));
        if (found) {
          found.claimed = true;
          return resolve(found.msg);
        }
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`timed out in ${name}`)), ms);
      }),
  };
  try {
    await api.request("initialize", {
      clientInfo: { name: "gram", title: "Gram", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    api.send({ method: "initialized" });
    await drive(api);
  } catch (error) {
    console.error(`${name} failed: ${error.message}\nstderr: ${stderr.slice(-1500)}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    server.close();
    // Codex may still be flushing its SQLite files as it exits.
    for (const dir of [home, cwd]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (error) {
        console.warn(`${name}: couldn't remove ${dir}: ${error.message}`);
      }
    }
  }
  const fixture = JSON.stringify(
    { scenario: name, cliVersion, messages: messages.map(({ dir, msg }) => ({ dir, msg })) },
    null,
    1,
  )
    .replaceAll(home, "$CODEX_HOME")
    .replaceAll(cwd, "$CWD")
    .replaceAll(`127.0.0.1:${port}`, "127.0.0.1:$PORT")
    .replace(/"serverName": "[^"]*"/g, '"serverName": "$HOST"')
    .replace(/"installationId": "[^"]*"/g, '"installationId": "$INSTALLATION"')
    .replace(/"userAgent": "[^"]*"/g, `"userAgent": "gram/${cliVersion}"`)
    .replace(/\/Users\/[^/"]+/g, "$HOME_DIR");
  if (fixture.includes(DUMMY_KEY)) throw new Error(`${name}: the key reached the stream`);
  writeFileSync(join(OUT, `${name}.json`), fixture + "\n");
  const methods = [
    ...new Set(
      messages
        .filter((m) => m.dir === "in")
        .map((m) => m.msg.method ?? (m.msg.error ? "error" : "response")),
    ),
  ];
  console.log(`${name}: ${messages.length} messages; in: ${methods.join(" ")}`);
  console.log(`${name} model requests: ${JSON.stringify(requests).slice(0, 1500)}`);
  if (mcpCalls.length) console.log(`${name} mcp: ${JSON.stringify(mcpCalls)}`);
  const errors = messages.filter((m) => m.msg.error);
  if (errors.length)
    console.log(`${name} errors: ${JSON.stringify(errors.map((m) => m.msg.error)).slice(0, 800)}`);
}

const startThread = (api, params = {}) =>
  api.request("thread/start", {
    cwd: api.cwd,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    ...params,
  });
const startTurn = (api, threadId, input) =>
  api.request("turn/start", {
    threadId,
    input: [{ type: "text", text: input, text_elements: [] }],
  });
const turnCompleted = (api, threadId) =>
  api.wait(
    (m) =>
      m.method === "turn/completed" && (threadId === undefined || m.params.threadId === threadId),
  );

await record(
  "cx01-text",
  async (api) => {
    const { result } = await startThread(api);
    await startTurn(api, result.thread.id, "Say hi");
    await turnCompleted(api);
  },
  [text("Hi there, how can I help?", { think: "The user wants a greeting." })],
);

await record(
  "cx04-steer",
  async (api) => {
    const { result } = await startThread(api);
    const { result: started } = await startTurn(api, result.thread.id, "Write a long story");
    await api.wait((m) => m.method === "item/agentMessage/delta");
    await api.request("turn/steer", {
      threadId: result.thread.id,
      expectedTurnId: started.turn.id,
      input: [{ type: "text", text: "Make it short", text_elements: [] }],
    });
    await turnCompleted(api);
  },
  [text("Once upon a time, far away", { pauseMs: 1500 }), text("Short version: the end.")],
);

await record(
  "cx05-interrupt",
  async (api) => {
    const { result } = await startThread(api);
    const { result: started } = await startTurn(api, result.thread.id, "Count to a million");
    await api.wait((m) => m.method === "item/agentMessage/delta");
    await api.request("turn/interrupt", { threadId: result.thread.id, turnId: started.turn.id });
    await turnCompleted(api);
  },
  [text("1, 2, 3, 4, 5, 6", { pauseMs: 15_000 })],
);

await record(
  "cx06-history",
  async (api) => {
    const { result } = await startThread(api);
    const threadId = result.thread.id;
    const { result: first } = await startTurn(api, threadId, "one");
    await turnCompleted(api);
    const { result: second } = await startTurn(api, threadId, "two");
    await turnCompleted(api);
    void second;
    await api.request("thread/fork", { threadId, lastTurnId: first.turn.id });
    await api.request("thread/list", { limit: 10 });
    await api.request("thread/read", { threadId, includeTurns: true });
    await api.request("thread/revert", { threadId, beforeTurnId: second.turn.id });
    await api.request("thread/read", { threadId, includeTurns: true });
    await api.request("thread/rollback", { threadId, numTurns: 1 });
  },
  [text("First answer."), text("Second answer.")],
);

await record(
  "cx08-mcp-config",
  async (api) => {
    const mcpFor = (token) => ({
      mcp_servers: {
        gram: {
          url: `http://127.0.0.1:${api.port}/mcp`,
          http_headers: { authorization: `Bearer ${token}` },
        },
      },
    });
    const { result: a } = await startThread(api, { config: mcpFor("thread-a") });
    const { result: b } = await startThread(api, { config: mcpFor("thread-b") });
    await api.sleep(1500);
    await api.request("mcpServerStatus/list", {});
    await startTurn(api, a.thread.id, "hi from a");
    await turnCompleted(api, a.thread.id);
    await startTurn(api, b.thread.id, "hi from b");
    await turnCompleted(api, b.thread.id);
  },
  [text("Hello A."), text("Hello B.")],
);

/** A reply that calls a tool, then (on the next request) answers in text. */
const toolCall = (item) => (n) => [
  created(`resp_${n}`),
  { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
  { type: "response.output_item.done", output_index: 0, item },
  done(`resp_${n}`),
];
const serverRequest = (api, method) => api.wait((m) => m.method === method && m.id !== undefined);

await record(
  "cx02-approval",
  async (api) => {
    const { result } = await startThread(api, { approvalPolicy: "untrusted" });
    await startTurn(api, result.thread.id, "Print hello");
    const request = await serverRequest(api, "item/commandExecution/requestApproval");
    api.respond(request.id, { decision: "accept" });
    await turnCompleted(api);
  },
  [
    toolCall({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "echo hello",
        sandbox_permissions: "require_escalated",
        justification: "Print a greeting",
      }),
    }),
    text("It printed hello."),
  ],
);

await record(
  "cx03-file-change",
  async (api) => {
    const { result } = await startThread(api, { approvalPolicy: "untrusted" });
    await startTurn(api, result.thread.id, "Add a hello file");
    const request = await serverRequest(api, "item/fileChange/requestApproval");
    api.respond(request.id, { decision: "decline" });
    await turnCompleted(api);
  },
  [
    toolCall({
      type: "custom_tool_call",
      id: "ctc_1",
      call_id: "call_2",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n",
    }),
    text("Okay, I won't add it."),
  ],
);

await record(
  "cx07-plan-question",
  async (api) => {
    const { result } = await startThread(api);
    await api.request("turn/start", {
      threadId: result.thread.id,
      input: [{ type: "text", text: "Plan a cleanup", text_elements: [] }],
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-5.5", reasoning_effort: null, developer_instructions: null },
      },
    });
    const request = await serverRequest(api, "item/tool/requestUserInput");
    api.respond(request.id, { answers: { scope: { answers: ["Tests only"] } } });
    await turnCompleted(api);
  },
  [
    toolCall({
      type: "function_call",
      id: "fc_3",
      call_id: "call_4",
      name: "request_user_input",
      arguments: JSON.stringify({
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "What should the cleanup cover?",
            options: [
              { label: "Tests only (Recommended)", description: "Only the test suite." },
              { label: "Everything", description: "The whole repository." },
            ],
          },
        ],
      }),
    }),
    text("Plan: clean up the tests."),
  ],
);

await record(
  "cx09-mcp-call",
  async (api) => {
    const { result } = await startThread(api, {
      config: {
        mcp_servers: {
          gram: {
            url: `http://127.0.0.1:${api.port}/mcp`,
            http_headers: { authorization: "Bearer thread-a" },
            // Gram's registry gates app tools itself.
            default_tools_approval_mode: "approve",
          },
        },
      },
    });
    await api.sleep(1500);
    await startTurn(api, result.thread.id, "Rename this thread to Tidy");
    await turnCompleted(api);
  },
  [
    toolCall({
      type: "tool_search_call",
      id: "ts_1",
      call_id: "call_ts",
      status: "completed",
      execution: "client",
      arguments: { query: "rename thread", limit: 4 },
    }),
    // `tool_search` exposes the server's tools as the `mcp__gram` namespace.
    toolCall({
      type: "function_call",
      id: "fc_2",
      call_id: "call_3",
      namespace: "mcp__gram",
      name: "rename_thread",
      arguments: JSON.stringify({ title: "Tidy" }),
    }),
    text("Renamed."),
  ],
);

await record(
  "cx10-mcp-status",
  async (api) => {
    const appTools = {
      url: `http://127.0.0.1:${api.port}/mcp`,
      http_headers: { authorization: "Bearer thread-a" },
      default_tools_approval_mode: "approve",
    };
    // A user-configured server, off for thread A only, next to A's own app-tools server.
    const { result: a } = await startThread(api, {
      config: { mcp_servers: { gram: appTools, docs: { enabled: false } } },
    });
    const { result: b } = await startThread(api);
    await api.sleep(1500);
    await api.request("mcpServerStatus/list", {
      threadId: a.thread.id,
      detail: "toolsAndAuthOnly",
    });
    await api.request("mcpServerStatus/list", {
      threadId: b.thread.id,
      detail: "toolsAndAuthOnly",
    });
    await api.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
    // A turn too, so the runtime replay test sees this recording's send and its end.
    await startTurn(api, a.thread.id, "hi");
    await turnCompleted(api, a.thread.id);
  },
  [text("Hi.")],
  { configToml: (port) => `[mcp_servers.docs]\nurl = "http://127.0.0.1:${port}/mcp-docs"\n` },
);

/** A LiteLLM proxy error, as the EXAMPLE gateway answers it. */
const gatewayError =
  (status, errorMessage, headers = {}) =>
  () => ({
    status,
    headers,
    body: { error: { message: errorMessage, type: "None", param: "None", code: String(status) } },
  });
// The gateway provider's retry budgets, as Gram passes them.
const gatewayRetries = [
  "-c",
  "model_providers.gram.request_max_retries=2",
  "-c",
  "model_providers.gram.stream_max_retries=2",
];
/** One turn that the gateway fails; the recording holds Codex's retries and its final error. */
const failedTurn = async (api) => {
  const { result } = await startThread(api);
  await startTurn(api, result.thread.id, "Say hi");
  await turnCompleted(api);
};

// LiteLLM's router filter: no deployment of the group takes a request with a hosted `web_search`
// tool, so it answers with its "no deployments" 429 and the cooldown fallback as `retry-after`.
await record(
  "cx11-gateway-no-deployments",
  failedTurn,
  [
    gatewayError(
      429,
      "litellm.RateLimitError: No deployments available for selected model, Try again in 20 seconds. Passed model=gpt-6.1-sol. pre-call-checks=False, cooldown_list=[]",
      { "retry-after": "1" },
    ),
  ],
  { args: gatewayRetries },
);

// The gateway's cost guard disables a key over its spending limit until someone re-enables it.
await record(
  "cx12-gateway-key-disabled",
  failedTurn,
  [gatewayError(403, "API key is disabled. Contact AI team.")],
  { args: gatewayRetries },
);

await record(
  "cx13-unauthorized",
  failedTurn,
  [gatewayError(401, "Authentication Error, Invalid proxy server token passed.")],
  { args: gatewayRetries },
);

await record(
  "cx14-model-not-found",
  failedTurn,
  [gatewayError(404, "litellm.NotFoundError: model gpt-9 not found")],
  { args: gatewayRetries },
);

// A compaction, which Codex starts by itself: the token limit is below what one turn reports, so the
// next turn compacts before it answers. (Gram never sends `thread/compact/start`.)
await record(
  "cx15-auto-compact",
  async (api) => {
    const { result } = await startThread(api);
    const threadId = result.thread.id;
    await startTurn(api, threadId, "Name three primary colours");
    await turnCompleted(api, threadId);
    await startTurn(api, threadId, "And one secondary colour");
    await turnCompleted(api, threadId);
  },
  [
    text("Red, yellow and blue."),
    text("The user asked for three primary colours; the answer was red, yellow and blue."),
    text("Green."),
  ],
  { args: ["-c", "model_auto_compact_token_limit=20"] },
);

console.log(`fixtures in ${OUT}`);
