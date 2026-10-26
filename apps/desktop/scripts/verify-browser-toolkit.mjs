// Explicit native qualification of the browser toolkit (batch, pointer and key input, cheaper reads,
// waits and viewport emulation): pinned Electron, an owned temporary profile and one loopback page,
// driven through both providers' real tool transports. Run with host Node; Bun only bundles the
// small Electron entry. No paid CLI is invoked.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
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
import { devServerTools } from "../../../packages/server/src/browser/dev-server-tools.ts";
import { createDevServerHost } from "../../../packages/server/src/browser/dev-servers.ts";
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
mkdirSync(output); // Refuse overwriting evidence.
const owned = mkdtempSync(join(tmpdir(), "gram-browser-toolkit-"));
const profile = join(owned, "profile");
mkdirSync(profile);
const entry = join(owned, "fixture.cjs");
// The threads' checkout: where browser_save_screenshot and browser_record write, and whose launch
// config preview_start reads.
const checkout = join(realpathSync(owned), "checkout");
mkdirSync(join(checkout, ".gram"), { recursive: true });
writeFileSync(
  join(checkout, "demo-server.cjs"),
  `require("node:http").createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Demo dev server</title><h1>Demo dev server on " + process.env.PORT + "</h1>")).listen(Number(process.env.PORT), "127.0.0.1", () => { console.log("ready on " + process.env.PORT); console.error("warning: synthetic dev warning"); });`,
);
writeFileSync(
  join(checkout, ".gram/launch.json"),
  JSON.stringify({
    configurations: [
      {
        name: "demo",
        runtimeExecutable: process.execPath,
        runtimeArgs: ["demo-server.cjs"],
        port: 47321,
      },
    ],
  }),
);
execFileSync("bun", [
  "build",
  "apps/desktop/scripts/fixtures/browser-toolkit.mjs",
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
function waitFor(predicate, ms = 15000) {
  const found = messages.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(receive);
      reject(new Error("Native fixture event deadline exceeded"));
    }, ms);
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
const post = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
let serial = 0;
async function control(type, fields = {}) {
  const id = `control-${++serial}`;
  post({ type, id, ...fields });
  return waitFor((m) => m.type === "fixture.response" && m.id === id);
}
const pane = bridgePane({ postMessage: post, on: (_event, receive) => listeners.push(receive) });
const threads = new Map(
  ["claude", "codex"].map((agent) => [
    agent,
    {
      id: agent,
      model: { agent, model: "synthetic-local-model" },
      mode: "bypassPermissions",
      spawnedBy: { threadId: "synthetic-root", feature: "fixture" },
      checkout: { kind: "worktree", path: checkout },
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
  audienceOf: () => Effect.succeed("worker"),
  // Only starting the project's dev server asks; the harness approves it and keeps the card.
  requestApproval: (_threadId, request) =>
    request.toolName === "mcp__gram__preview_start"
      ? Effect.sync(() => {
          cards.push(request);
          return { kind: "approval", decision: "allow", scope: "once" };
        })
      : Effect.die("The owned loopback workflow must not ask for public consent"),
  currentSession: () => Effect.succeed(undefined),
};
const cards = [];
const devHost = createDevServerHost({ env: async () => ({ PATH: process.env.PATH }) });
const definitions = [
  ...browserTools({ pane, store, hub, runtimes, appOrigins: Effect.succeed([]) }),
  ...devServerTools({ host: devHost, hub, store, runtimes }),
];
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
const textOf = (result) =>
  result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
const ok = (result) => {
  assert(!result.isError, textOf(result));
  return result;
};
const refFor = (outline, pattern) => {
  const ref = outline
    .split("\n")
    .find((line) => pattern.test(line))
    ?.match(/\[(ref_\d+)\]/)?.[1];
  assert(ref, `no ${pattern} in\n${outline}`);
  return ref;
};
const save = (result, label) => {
  const images = result.content.filter((part) => part.type === "image");
  images.forEach((image, index) =>
    writeFileSync(
      join(output, `${label}${images.length > 1 ? `-${index + 1}` : ""}.jpg`),
      Buffer.from(image.data, "base64"),
    ),
  );
  return images;
};
const record = (line) => {
  evidence.results.push(line);
  console.log(`✓ ${line}`);
};
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
      const claude = (name, input) => {
        const tool = sdkTools.get(name);
        assert(tool, `missing shared tool ${name}`);
        tool.input.parse(input);
        return tool.handler(input, {});
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
      const codex = (name, input) => client.callTool({ name, arguments: input });
      const listed = yield* Effect.promise(() => client.listTools());
      const names = listed.tools.map((tool) => tool.name);
      for (const name of [
        "browser_batch",
        "browser_hover",
        "browser_scroll",
        "browser_scroll_to",
        "browser_drag",
        "browser_wait",
      ]) {
        assert(names.includes(name), `${name} not listed`);
        assert(sdkTools.has(name), `${name} not in the Claude SDK server`);
      }
      record("Both transports list batch, hover, scroll, scroll_to, drag and wait");

      yield* Effect.promise(async () => {
        // Batch, through Claude's SDK schema: steps run in order, images interleave with text.
        const batch = ok(
          await claude("browser_batch", {
            actions: [
              { name: "browser_navigate", input: { url: ready.origin } },
              { name: "browser_snapshot", input: { filter: "interactive" } },
              { name: "browser_screenshot", input: {} },
              { name: "browser_screenshot", input: { scale: 0.5 } },
            ],
          }),
        );
        const images = save(batch, "batch-opening");
        assert.equal(images.length, 2);
        const kinds = batch.content.map((part) => part.type).join(",");
        assert.match(kinds, /text,image,text,text,image/);
        // A capture is in device pixels; scale 0.5 halves it, whatever the display's density.
        const widths = [...textOf(batch).matchAll(/"imageWidth":(\d+)/g)].map((m) => Number(m[1]));
        assert.equal(widths.length, 2);
        assert.equal(widths[1], widths[0] / 2);
        evidence.captureWidths = widths;
        assert(!textOf(batch).includes('text "Row 1"'), "interactive snapshot kept text runs");
        record(
          "Claude SDK batch: navigate → interactive snapshot → full and half-scale screenshots, in order, with the half-scale image half as wide, images interleaved with their text",
        );

        // A batch stops at its first failure and runs nothing after it.
        ok(await codex("browser_navigate", { url: ready.origin }));
        const stopped = await codex("browser_batch", {
          actions: [
            { name: "browser_click", input: { ref: "ref_99999" } },
            { name: "browser_type", input: { text: "never" } },
          ],
        });
        assert.match(textOf(stopped), /Step 1 of 2, browser_click failed/);
        assert.match(textOf(stopped), /The batch stopped here/);
        assert(!textOf(stopped).includes("Step 2 of 2"));
        record("Codex HTTP batch stops at a stale ref and never runs the step after it");

        const outline = textOf(ok(await codex("browser_snapshot", {})));
        const hover = refFor(outline, /Hover for menu/);
        const dbl = refFor(outline, /button "Double or right click"/);
        const card = refFor(outline, /Drag this card/);
        const zone = refFor(outline, /Drop zone/);
        const volume = refFor(outline, /slider "Volume"/);
        const count = refFor(outline, /textbox "Count"/);
        const later = refFor(outline, /button "Finish later"/);
        const bottom = refFor(outline, /button "Bottom action"/);
        // The status line is the first non-empty line after the heading.
        const status = async () =>
          textOf(ok(await codex("browser_text", {})))
            .split("<page-content-")[1]
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")[2];

        const systemScheme = /scheme (light|dark)/.exec(
          textOf(ok(await codex("browser_text", {}))),
        )[1];
        evidence.systemScheme = systemScheme;
        // Cheaper reads.
        const shallow = textOf(ok(await codex("browser_snapshot", { depth: 1 })));
        assert.match(shallow, /deeper levels left out at depth 1/);
        const sub = textOf(ok(await codex("browser_snapshot", { ref: hover })));
        assert.match(sub, /Hover for menu/);
        assert(!sub.includes("Finish later"));
        const cut = textOf(ok(await codex("browser_snapshot", { maxChars: 300 })));
        assert.match(cut, /cut at 300 characters/);
        const shortText = textOf(ok(await codex("browser_text", { maxChars: 200 })));
        assert.match(shortText, /cut at 200 of \d+ characters/);
        record("Snapshot depth, ref subtree and maxChars, and text maxChars, each cut with a note");

        ok(await codex("browser_hover", { ref: hover }));
        assert.equal(await status(), "Menu open");
        save(ok(await codex("browser_screenshot", { ref: hover })), "hover-menu");
        record("Hover opens a mouseenter menu without taking the pane from the agent");

        ok(await codex("browser_click", { ref: dbl, double: true }));
        assert.equal(await status(), "Double-clicked");
        ok(await codex("browser_click", { ref: dbl, button: "right" }));
        assert.equal(await status(), "Context menu");
        record("Double click and right click reach the page's dblclick and contextmenu handlers");

        ok(await codex("browser_drag", { from: { ref: card }, to: { ref: zone } }));
        assert.equal(await status(), "Dropped");
        assert.match(textOf(ok(await codex("browser_text", {}))), /Dropped card/);
        save(ok(await codex("browser_screenshot", {})), "drag-dropped");
        const slider = textOf(ok(await codex("browser_screenshot", { ref: volume })));
        const region = JSON.parse(/"region":(\{[^}]+\})/.exec(slider)[1]);
        const y = Math.round(region.y + region.height / 2);
        ok(
          await codex("browser_drag", {
            from: { coordinate: [Math.round(region.x + 2), y] },
            to: { coordinate: [Math.round(region.x + region.width - 2), y] },
          }),
        );
        assert.match(await status(), /^Volume (9\d|100)$/);
        record(
          "HTML drag-and-drop drops the card through the protocol; a pointer drag moves a range input",
        );

        ok(await codex("browser_press_key", { ref: count, key: "ArrowUp", repeat: 3 }));
        assert.match(textOf(ok(await codex("browser_find", { query: "Count" }))), /value="3"/);
        ok(await codex("browser_press_key", { key: "k", modifiers: ["meta"] }));
        assert.equal(await status(), "Palette opened");
        ok(await codex("browser_press_key", { key: "9", modifiers: ["meta", "shift"] }));
        ok(await codex("browser_press_key", { key: "9", modifiers: ["ctrl", "shift"] }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert(
          !messages.some((m) => m.type === "fixture.accelerator"),
          "A synthetic key reached the app menu",
        );
        const driver = await control("fixture.driver", { threadId: "codex" });
        assert.equal(driver.driver, "agent");
        record(
          "Keys: ArrowUp ×3 on a ref, Meta+K reaches the page, Meta/Ctrl+Shift+9 never reaches the app menu accelerator, and the agent keeps the pane",
        );

        ok(await codex("browser_click", { ref: later }));
        const waited = textOf(ok(await codex("browser_wait", { text: "Finished", seconds: 5 })));
        assert.match(waited, /"Finished" is shown/);
        const notYet = textOf(ok(await codex("browser_wait", { text: "Never", seconds: 0.5 })));
        assert.match(notYet, /still isn't shown/);
        record("Wait returns once text appears, and says when it didn't within its seconds");

        ok(await codex("browser_scroll", { direction: "down", amount: 5 }));
        assert.match(textOf(ok(await codex("browser_snapshot", { depth: 1 }))), /scrolled [1-9]/);
        ok(await codex("browser_scroll_to", { ref: bottom }));
        ok(await codex("browser_click", { ref: bottom }));
        assert.equal(await status(), "Bottom clicked");
        record("Wheel scroll moves the page; scroll_to brings a far ref into view to click");

        ok(
          await codex("browser_viewport", {
            width: 375,
            height: 700,
            mobile: true,
            colorScheme: systemScheme === "dark" ? "light" : "dark",
          }),
        );
        const emulated = systemScheme === "dark" ? "light" : "dark";
        // Size and scheme reach the open page; touch and the agent are what it reads from now.
        // The page redraws its line from its own resize and media listeners, after the call.
        assert.match(
          textOf(
            ok(await codex("browser_wait", { text: `Width 375 · scheme ${emulated}`, seconds: 5 })),
          ),
          /is shown/,
        );
        ok(await codex("browser_navigate", { url: ready.origin }));
        assert.match(
          textOf(ok(await codex("browser_text", {}))),
          new RegExp(`Width 375 · scheme ${emulated} · touch 5 · mobile agent`),
        );
        save(ok(await codex("browser_screenshot", {})), `phone-${emulated}`);
        // Input works under phone emulation on a page made for phones.
        const phoneOutline = textOf(ok(await codex("browser_snapshot", { filter: "interactive" })));
        ok(
          await codex("browser_click", {
            ref: refFor(phoneOutline, /Double or right click/),
            button: "right",
          }),
        );
        assert.equal(await status(), "Context menu");
        // A page without a viewport meta is laid out wider and shown zoomed out on a phone.
        ok(await codex("browser_navigate", { url: `${ready.origin}/desktop-only` }));
        const wide = textOf(ok(await codex("browser_snapshot", { filter: "interactive" })));
        const zoomed = await codex("browser_click", {
          ref: refFor(wide, /Double or right click/),
          button: "right",
        });
        evidence.desktopOnlyPageOnPhone = zoomed.isError
          ? `refused: ${/Viewport geometry unavailable or zoomed|failed[^.]*/.exec(textOf(zoomed))?.[0] ?? "error"}`
          : "clicked";
        ok(await codex("browser_viewport", { preset: "pane", colorScheme: "system" }));
        ok(await codex("browser_navigate", { url: ready.origin }));
        const clipboard = await codex("browser_press_key", { key: "v", modifiers: ["meta"] });
        assert(clipboard.isError);
        assert.match(textOf(clipboard), /Clipboard shortcuts/);
        assert.match(
          textOf(ok(await codex("browser_text", {}))),
          new RegExp(`Width 800 · scheme ${systemScheme} · touch 0 · desktop agent`),
        );
        ok(await codex("browser_viewport", { width: 1024, height: 640 }));
        // Measured by the capture itself, not the page's resize handler.
        assert.match(
          textOf(ok(await codex("browser_screenshot", { scale: 0.25 }))),
          /"viewport":\{"width":1024,"height":640,/,
        );
        ok(await codex("browser_viewport", { preset: "pane" }));
        record(
          `Viewport: 375×700 with the scheme opposite the system's reaches the open page; after a reload it reads touch 5 and an Android agent and takes a click; a page without a viewport meta under phone emulation: ${evidence.desktopOnlyPageOnPhone}; back to the pane's size, the system's scheme and a desktop agent, then a custom 1024×640`,
        );

        // Local debugging, on the fixture's loopback page.
        ok(await codex("browser_navigate", { url: ready.origin }));
        assert.match(
          textOf(ok(await codex("browser_evaluate", { expression: "document.title" }))),
          /"Browser toolkit fixture"/,
        );
        assert.match(
          textOf(
            ok(
              await codex("browser_evaluate", {
                expression: "fetch('/data.json').then((r) => r.status)",
                actionSummary: "Fetches the fixture's data",
              }),
            ),
          ),
          /\n200\n/,
        );
        const requests = textOf(ok(await codex("browser_network", { filter: "data.json" })));
        const requestId = /^(\S+) GET 200 Fetch/m.exec(requests)?.[1];
        assert(requestId, requests);
        assert.match(
          textOf(ok(await codex("browser_network", { requestId }))),
          /<title>Browser toolkit fixture<\/title>/,
        );
        record(
          "Loopback page: browser_evaluate returns the title and an awaited fetch status; browser_network lists that request and returns its body by id",
        );

        // Evidence written by the tools themselves into the thread's folder.
        const shot = textOf(
          ok(await codex("browser_save_screenshot", { path: "evidence/batch-and-input.png" })),
        );
        assert.match(
          shot,
          /^Saved evidence\/batch-and-input\.png \((\d+)×(\d+) PNG of a 800×650 viewport\)/,
        );
        const png = readFileSync(join(checkout, "evidence/batch-and-input.png"));
        assert.equal(png.subarray(1, 4).toString(), "PNG");
        const escaped = await codex("browser_save_screenshot", { path: "../escape.png" });
        assert(escaped.isError);
        ok(await codex("browser_record", { action: "start", scale: 0.5 }));
        assert.equal((await control("fixture.driver", { threadId: "codex" })).recording, true);
        const flowOutline = textOf(ok(await codex("browser_snapshot", {})));
        ok(
          await codex("browser_batch", {
            actions: [
              {
                name: "browser_hover",
                input: {
                  ref: refFor(flowOutline, /Hover for menu/),
                  actionSummary: "Opens the hover menu",
                },
              },
              { name: "browser_wait", input: { seconds: 0.6 } },
              {
                name: "browser_drag",
                input: {
                  from: { ref: refFor(flowOutline, /Drag this card/) },
                  to: { ref: refFor(flowOutline, /Drop zone/) },
                  actionSummary: "Drops the card in the zone",
                },
              },
              { name: "browser_wait", input: { text: "Dropped card", seconds: 2 } },
              { name: "browser_wait", input: { seconds: 0.6 } },
            ],
          }),
        );
        const action = (await control("fixture.driver", { threadId: "codex" })).action;
        assert.equal(action?.summary, "Drops the card in the zone");
        const recorded = textOf(
          ok(
            await codex("browser_record", { action: "stop", path: "evidence/hover-and-drag.gif" }),
          ),
        );
        assert.match(recorded, /^Saved evidence\/hover-and-drag\.gif: (\d+) frames over/);
        const frames = Number(/: (\d+) frames/.exec(recorded)[1]);
        assert(frames >= 2, recorded);
        const gif = readFileSync(join(checkout, "evidence/hover-and-drag.gif"));
        assert.equal(gif.subarray(0, 6).toString(), "GIF89a");
        assert.equal((await control("fixture.driver", { threadId: "codex" })).recording, false);
        ok(await codex("browser_save_screenshot", { path: "evidence/after-drop.png" }));
        evidence.recordedFrames = frames;
        evidence.gifBytes = gif.length;
        record(
          `browser_save_screenshot writes a PNG inside the thread's folder and refuses ../; browser_record captures a batch of labelled hover and drag into a ${frames}-frame GIF; the pane keeps the latest actionSummary`,
        );

        // A dev server from the project's launch config, started, browsed, read and stopped.
        const started = textOf(ok(await codex("preview_start", { name: "demo" })));
        const url = /at (http:\/\/localhost:\d+\/)/.exec(started)?.[1];
        assert(url, started);
        assert.equal(cards.length, 1);
        assert.match(cards[0].description, /demo-server\.cjs/);
        ok(await codex("browser_navigate", { url }));
        assert.match(textOf(ok(await codex("browser_text", {}))), /Demo dev server on \d+/);
        ok(await codex("browser_save_screenshot", { path: "evidence/dev-server.png" }));
        assert.match(
          textOf(ok(await codex("preview_list", {}))),
          /demo: http:\/\/localhost:\d+\/ — running/,
        );
        assert.match(
          textOf(ok(await codex("preview_logs", { name: "demo", level: "warn" }))),
          /\[warn\] warning: synthetic dev warning/,
        );
        // A second start of the same server answers that it runs; no second card.
        assert.match(textOf(ok(await codex("preview_start", { name: "demo" }))), /already running/);
        ok(await codex("preview_stop", { name: "demo" }));
        assert.equal(cards.length, 1);
        assert.match(textOf(ok(await codex("preview_list", {}))), /demo: not started/);
        for (const file of [
          "batch-and-input.png",
          "after-drop.png",
          "dev-server.png",
          "hover-and-drag.gif",
        ])
          copyFileSync(join(checkout, "evidence", file), join(output, file));
        record(
          "preview_start asks once naming the command, starts the project's server, the agent browses and captures it, reads its warnings, and preview_stop stops it",
        );
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
  await devHost.stopAll();
  rmSync(owned, { recursive: true, force: true });
}
