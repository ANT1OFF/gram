// Explicit native qualification: installed pinned Electron in an owned temporary profile.
// Run with host Node; Bun only bundles the small Electron entry. No paid CLI is invoked.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppToolRegistry } from "../../../packages/server/src/app-tools/registry.ts";
import { McpRoute } from "../../../packages/server/src/app-tools/http-mcp.ts";
import { McpTokens, mcpConnectionFor } from "../../../packages/server/src/app-tools/mcp-tokens.ts";
import { browserTools } from "../../../packages/server/src/browser/tools.ts";
import { bridgePane } from "../../../packages/server/src/browser/pane-port.ts";
import { buildAppToolServer } from "../../../packages/agents/src/claude/apptools.ts";
import { ThreadStore } from "../../../packages/server/src/persistence/thread-store.ts";
import { ThreadRuntimes } from "../../../packages/server/src/runtime/thread-runtimes.ts";
import { EventHub } from "../../../packages/server/src/events/event-hub.ts";
import { ThreadPlans } from "../../../packages/server/src/plans/service.ts";
import { ThreadWaits } from "../../../packages/server/src/waits/service.ts";
import { CheckoutService } from "../../../packages/server/src/runtime/hooks.ts";
import { ServerConfig } from "../../../packages/server/src/config.ts";
import { AuthMiddleware, LaunchToken } from "../../../packages/server/src/http/server.ts";
import { HttpRouter } from "../../../packages/server/src/platform/unstable.ts";

const output = resolvePath(process.argv[2]);
const before = process.argv[3] === "--before";
mkdirSync(output); // Refuse overwriting evidence.
const owned = mkdtempSync("/tmp/gram-browser-");
const profile = join(owned, "profile");
mkdirSync(profile);
const entry = join(owned, "fixture.cjs");
execFileSync("bun", [
  "build",
  "apps/desktop/scripts/fixtures/local-browser.mjs",
  "--target=node",
  "--format=cjs",
  "--external=electron",
  `--outfile=${entry}`,
]);
const require = createRequire(import.meta.url);
const env = { PATH: process.env.PATH, HOME: owned, TMPDIR: owned };
const child = spawn(require("electron"), [entry, profile], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
const messages = [];
const waiters = new Set();
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
function waitFor(predicate) {
  const found = messages.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(receive);
      reject(new Error("Native fixture event deadline exceeded"));
    }, 10000);
    const receive = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      waiters.delete(receive);
      resolve(message);
    };
    waiters.add(receive);
  });
}
const listeners = [];
lines.on("line", (line) => {
  if (!line.startsWith("{")) return;
  const message = JSON.parse(line);
  messages.push(message);
  for (const receive of waiters) receive(message);
  for (const receive of listeners) receive({ data: message });
});
const posted = [];
const post = (message) => {
  posted.push(message);
  return child.stdin.write(`${JSON.stringify(message)}\n`);
};
let serial = 0;
async function control(type, fields = {}) {
  const id = `control-${++serial}`;
  post({ type, id, ...fields });
  await waitFor((m) => m.type === "fixture.response" && m.id === id);
  return id;
}
const pane = bridgePane({ postMessage: post, on: (_event, receive) => listeners.push(receive) });
const threads = new Map(
  ["claude", "codex", "foreign", "dream"].map((agent) => [
    agent,
    {
      id: agent,
      role: agent === "dream" ? "dream" : undefined,
      model: { agent: agent === "codex" ? "codex" : "claude", model: "synthetic-local-model" },
      mode: "bypassPermissions",
      spawnedBy: { threadId: "synthetic-root", feature: "fixture" },
    },
  ]),
);
const store = {
  getThread: (id) =>
    Effect.sync(() => {
      assert(threads.has(id));
      return threads.get(id);
    }),
  getSettings: Effect.succeed({ orchestration: { enabled: false } }),
  getWorkspace: () => Effect.die("No synthetic workspace"),
};
const hub = { publish: () => Effect.void };
const runtimes = {
  setAppTools: () => Effect.void,
  audienceOf: (id) => Effect.succeed(id === "dream" ? "dream" : "worker"),
  requestApproval: () => Effect.die("The owned loopback workflow must not ask for public consent"),
  currentSession: () => Effect.succeed(undefined),
};
const definitions = browserTools({ pane, store, hub, runtimes, appOrigins: Effect.succeed([]) });
const deps = Layer.mergeAll(
  Layer.succeed(ThreadStore, store),
  Layer.succeed(ThreadRuntimes, runtimes),
  Layer.succeed(EventHub, hub),
  Layer.succeed(ThreadPlans, {}),
  Layer.succeed(ThreadWaits, {}),
  Layer.succeed(CheckoutService, {}),
);
const registryLayer = AppToolRegistry.layer.pipe(Layer.provide(deps));
const serverLayer = HttpRouter.serve(Layer.mergeAll(McpRoute, AuthMiddleware), {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(registryLayer),
  Layer.provideMerge(McpTokens.layer),
  Layer.provideMerge(LaunchToken.layer),
  Layer.provideMerge(ServerConfig.layer({ port: 0, extraOrigins: [], webRoot: undefined })),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
);
const evidence = {
  platform: process.platform,
  arch: process.arch,
  providerState: "invented subscription/auth/model; no CLI or inference",
  results: [],
};
const refOf = (result) => {
  const ref = /combobox "Project" \[(ref_\d+)\]/.exec(result.content[0].text)?.[1];
  assert(ref, result.content[0].text);
  return ref;
};
const textOf = (result) =>
  result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
async function shot(call, label) {
  const result = await call("browser_screenshot", {});
  assert(!result.isError, textOf(result));
  assert.equal(result.content[0].type, "text");
  const image = result.content.find((part) => part.type === "image");
  assert.equal(image?.mimeType, "image/jpeg");
  writeFileSync(join(output, `${label}.jpg`), Buffer.from(image.data, "base64"));
  assert.match(textOf(result), /imageWidth/);
}
try {
  const ready = await waitFor((m) => m.type === "fixture.ready");
  evidence.native = {
    electron: ready.electron,
    node: ready.node,
    viewport: "800×650",
    profile: "owned ephemeral partition",
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      yield* registry.register(definitions);
      const sdkTools = new Map();
      buildAppToolServer(
        "claude",
        registry,
        {
          tool: (name, _description, input, handler) => {
            sdkTools.set(name, { input, handler });
            return { name };
          },
          createSdkMcpServer: () => ({ type: "sdk", name: "gram", instance: {} }),
        },
        "worker",
      );
      const claude = (name, input, signal) => {
        const tool = sdkTools.get(name);
        assert(tool, `missing shared tool ${name}`);
        tool.input.parse(input);
        return tool.handler(input, { signal });
      };
      const connection = yield* mcpConnectionFor("codex");
      const client = new Client({ name: "synthetic-codex", version: "1.0.0" });
      yield* Effect.promise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(connection.url), {
            requestInit: { headers: connection.headers },
          }),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
      const codex = (name, input, signal) =>
        client.callTool({ name, arguments: input }, undefined, { signal });
      const listed = yield* Effect.promise(() => client.listTools());
      if (!before)
        // The named keys, these three among them, beside one printable character.
        for (const key of ["ArrowDown", "ArrowUp", "Escape"])
          assert(
            listed.tools
              .find((t) => t.name === "browser_press_key")
              .inputSchema.properties.key.anyOf.some((branch) => branch.enum?.includes(key)),
          );
      assert(
        !registry
          .forSession("dream", "dream")
          .some((t) => t.descriptor.name.startsWith("browser_")),
      );
      for (const [provider, call] of [
        ["claude", claude],
        ["codex", codex],
      ]) {
        yield* Effect.promise(async () => {
          assert(!(await call("browser_navigate", { url: ready.origin })).isError);
          const ref = refOf(await call("browser_snapshot", {}));
          assert(!(await call("browser_click", { ref })).isError);
          await shot(call, `${provider}-before`);
          if (before) {
            assert(!listed.tools.some((tool) => tool.name === "browser_press_key"));
            assert((await call("browser_form_input", { ref, value: "Teal" })).isError);
            await call("browser_type", { ref, text: "", submit: true });
            assert.match(textOf(await call("browser_text", {})), /Selected: none/);
            await shot(call, `${provider}-after`);
            evidence.results.push(
              `${provider}: original catalog has no arrow-key tool; div combobox cannot be set by formInput, existing Enter leaves Selected: none`,
            );
            return;
          }
          for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "ArrowDown"]) {
            const result = await call("browser_press_key", { ref, key });
            assert(!result.isError, textOf(result));
            assert.match(textOf(result), /dispatch-completed/);
          }
          assert(!(await call("browser_type", { ref, text: "", submit: true })).isError);
          assert.match(textOf(await call("browser_text", {})), /Selected: Teal/);
          await shot(call, `${provider}-after`);
          await call("browser_click", { ref });
          await call("browser_press_key", { ref, key: "Escape" });
          assert(!textOf(await call("browser_snapshot", {})).includes("listbox"));
          // These arguments cannot redirect this token/session to a sibling target.
          const foreign = await call("browser_press_key", {
            ref,
            key: "ArrowDown",
            threadId: "foreign",
          });
          assert(foreign.isError);
          const stale = await call("browser_navigate", { url: `${ready.origin}/replacement` });
          assert(!stale.isError);
          assert((await call("browser_press_key", { ref, key: "ArrowDown" })).isError);
          evidence.results.push(
            `${provider}: shared catalog → navigate → snapshot → click → arrows → existing Enter → selected text + image → Escape; foreign target and stale ref rejected`,
          );
        });
      }
      if (before) return;
      for (const [provider, call] of [
        ["claude", claude],
        ["codex", codex],
      ]) {
        yield* Effect.promise(async () => {
          assert(
            !(await call("browser_navigate", { url: `${ready.origin}/history-previous` })).isError,
          );
          assert(
            !(await call("browser_navigate", { url: `${ready.origin}/history-current` })).isError,
          );
          const returned = await call("browser_navigate", { url: "back" });
          assert(!returned.isError, textOf(returned));
          assert(textOf(returned).includes(`${ready.origin}/history-previous`));
          refOf(await call("browser_snapshot", {}));
          evidence.results.push(
            `${provider}: actual native forward/back navigation reports the authorized previous URL and a fresh snapshot`,
          );
        });
      }
      yield* Effect.promise(async () => {
        await claude("browser_navigate", { url: `${ready.origin}/focus-away` });
        const ref = refOf(await claude("browser_snapshot", {}));
        const key = await claude("browser_press_key", { ref, key: "ArrowDown" });
        assert(key.isError, "A ref that redirects focus must not receive key dispatch");
        assert(!textOf(await claude("browser_text", {})).includes("Wrong target received a key"));
        await claude("browser_navigate", { url: ready.origin });
        evidence.results.push(
          "Actual native redirected focus rejects the ref before sending a key to another control",
        );
      });
      yield* Effect.promise(async () => {
        const ref = refOf(await claude("browser_snapshot", {}));
        const id = await control("fixture.pause", { method: "Page.captureScreenshot" });
        const reading = claude("browser_screenshot", {});
        await waitFor((m) => m.type === "fixture.paused" && m.id === id);
        const key = claude("browser_press_key", { ref, key: "ArrowDown" });
        await control("fixture.replace", { threadId: "claude" });
        post({ type: "fixture.release", id });
        assert((await reading).isError);
        const stale = await key;
        assert(stale.isError);
        assert.match(textOf(stale), /staleRef/);
        assert(!textOf(await claude("browser_snapshot", {})).includes("listbox"));
        evidence.results.push(
          "Queued native key rejects a replacement document; stale capture bytes are withheld",
        );
      });
      yield* Effect.promise(async () => {
        const foreign = registry
          .forTransport("foreign", "worker")
          .find((tool) => tool.descriptor.name === "browser_press_key");
        await assert.rejects(
          Effect.runPromise(foreign.run({ ref: "ref_1", key: "ArrowDown" })),
          /Nothing is open/,
        );
        evidence.results.push(
          "An unopened sibling's bound registry tool cannot operate either provider's page",
        );
      });
      const dreamConnection = yield* mcpConnectionFor("dream");
      yield* Effect.promise(async () => {
        const dream = new Client({ name: "synthetic-dream", version: "1.0.0" });
        try {
          await dream.connect(
            new StreamableHTTPClientTransport(new URL(dreamConnection.url), {
              requestInit: { headers: dreamConnection.headers },
            }),
          );
          await assert.rejects(
            dream.callTool({
              name: "browser_press_key",
              arguments: { ref: "ref_1", key: "ArrowDown" },
            }),
            /Unknown tool/,
          );
        } finally {
          await dream.close();
        }
        evidence.results.push("Dream HTTP direct invocation rejects the browser tool");
        const incorrectlyBound = registry
          .forTransport("dream", "worker")
          .find((tool) => tool.descriptor.name === "browser_press_key");
        await assert.rejects(
          Effect.runPromise(incorrectlyBound.run({ ref: "ref_1", key: "ArrowDown" })),
          /Dream runs cannot use browser tools/,
        );
        evidence.results.push(
          "Dream under an incorrect ordinary binding is refused authoritatively before pane dispatch",
        );
      });
      yield* Effect.promise(async () => {
        // Real SDK abort → Effect interruption → pane.cancel → queued Electron work withdrawn.
        const ref = refOf(await claude("browser_snapshot", {}));
        const id = await control("fixture.pause", { method: "Page.captureScreenshot" });
        const reading = claude("browser_screenshot", {});
        await waitFor((m) => m.type === "fixture.paused" && m.id === id);
        const abort = new AbortController();
        const key = claude("browser_press_key", { ref, key: "ArrowDown" }, abort.signal);
        const rejected = assert.rejects(key);
        abort.abort();
        await rejected;
        const cancelled = posted.findLast(
          (m) => m.type === "pane.request" && m.request.command.op === "pressKey",
        ).id;
        await waitFor((m) => m.type === "fixture.cancelled" && m.id === cancelled);
        post({ type: "fixture.release", id });
        await reading;
        assert(!textOf(await claude("browser_snapshot", {})).includes("listbox"));
        evidence.results.push(
          "Claude SDK abort withdraws queued native key input; no listbox opened",
        );
      });
      yield* Effect.promise(async () => {
        const ref = refOf(await codex("browser_snapshot", {}));
        const id = await control("fixture.pause", { method: "DOM.focus" });
        const abort = new AbortController();
        const key = codex("browser_press_key", { ref, key: "ArrowDown" }, abort.signal);
        const rejected = assert.rejects(key);
        await waitFor((m) => m.type === "fixture.paused" && m.id === id);
        abort.abort();
        await rejected;
        const cancelled = posted.findLast(
          (m) => m.type === "pane.request" && m.request.command.op === "pressKey",
        ).id;
        await waitFor((m) => m.type === "fixture.cancelled" && m.id === cancelled);
        post({ type: "fixture.release", id });
        assert(!textOf(await codex("browser_snapshot", {})).includes("listbox"));
        evidence.results.push(
          "Codex HTTP MCP abort during focus prevents subsequent native key dispatch",
        );
      });
      yield* Effect.promise(async () => {
        const ref = refOf(await claude("browser_snapshot", {}));
        const id = await control("fixture.pause", { method: "DOM.focus" });
        const key = claude("browser_press_key", { ref, key: "ArrowDown" });
        await waitFor((m) => m.type === "fixture.paused" && m.id === id);
        await control("fixture.takeOver", { threadId: "claude" });
        post({ type: "fixture.release", id });
        const refused = await key;
        assert(refused.isError);
        assert.match(textOf(refused), /userHasControl/);
        assert(!textOf(await claude("browser_snapshot", {})).includes("listbox"));
        await control("fixture.handBack", { threadId: "claude" });
        evidence.results.push("Native user takeover during focus stops subsequent key dispatch");
      });
      const tokens = yield* McpTokens;
      const revocationPause = yield* Effect.promise(() =>
        control("fixture.pause", { method: "DOM.focus" }),
      );
      const revocationRef = yield* Effect.promise(async () =>
        refOf(await codex("browser_snapshot", {})),
      );
      const revokedCall = codex("browser_press_key", { ref: revocationRef, key: "ArrowDown" });
      const rejectedRevocation = assert.rejects(revokedCall);
      yield* Effect.promise(() =>
        waitFor((m) => m.type === "fixture.paused" && m.id === revocationPause),
      );
      yield* tokens.revoke("codex");
      yield* Effect.promise(async () => {
        await rejectedRevocation;
        const cancelled = posted.findLast(
          (m) => m.type === "pane.request" && m.request.command.op === "pressKey",
        ).id;
        await waitFor((m) => m.type === "fixture.cancelled" && m.id === cancelled);
        post({ type: "fixture.release", id: revocationPause });
      });
      const newConnection = yield* mcpConnectionFor("codex");
      yield* Effect.promise(async () => {
        const replacement = new Client({ name: "synthetic-codex-replacement", version: "1.0.0" });
        try {
          await replacement.connect(
            new StreamableHTTPClientTransport(new URL(newConnection.url), {
              requestInit: { headers: newConnection.headers },
            }),
          );
          const snapshot = await replacement.callTool({ name: "browser_snapshot", arguments: {} });
          assert(!textOf(snapshot).includes("listbox"));
          await shot(
            (name, args) => replacement.callTool({ name, arguments: args }),
            "codex-after-revocation",
          );
        } finally {
          await replacement.close();
        }
        evidence.results.push(
          "Native token revocation cancels paused input; a fresh token observes unchanged text/image state",
        );
      });
      yield* Effect.promise(async () => {
        const id = await control("fixture.pause", { method: "Page.captureScreenshot" });
        const reading = claude("browser_screenshot", {});
        await waitFor((m) => m.type === "fixture.paused" && m.id === id);
        await control("fixture.close", { threadId: "claude" });
        post({ type: "fixture.release", id });
        const result = await reading;
        assert(result.isError);
        assert(!result.content.some((part) => part.type === "image"));
        evidence.results.push("Native target closure withholds a pending capture and its bytes");
      });
    }).pipe(Effect.provide(serverLayer), Effect.scoped),
  );
  writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  writeFileSync(join(output, "failure.txt"), `${error.stack}\n${stderr}`);
  throw error;
} finally {
  post({ type: "fixture.stop" });
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => child.kill(), 5000).unref();
  });
  lines.close();
  rmSync(owned, { recursive: true, force: true });
}
