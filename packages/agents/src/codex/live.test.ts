import { describe, expect, it } from "@effect/vitest";
import { ProfileId, ThreadId, type AgentEvent } from "@gram/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { runCommand } from "../cli/process.ts";
import { GatewayKeyProvider } from "../gateway.ts";
import type { OpenSessionOptions } from "../host.ts";
import { CodexHostLive } from "./live.ts";
import { CodexServers, CodexServersLive } from "./servers.ts";
import { CodexHost, CodexHostLayer } from "./session.ts";

// `GRAM_LIVE_CODEX=1`: the installed `codex app-server` against a scripted local Responses API, with a
// temp CODEX_HOME and a dummy key. No gateway, no network beyond localhost.
const live = process.env["GRAM_LIVE_CODEX"] === "1";

const reply = (text: string) =>
  [
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant", id: "msg_1", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 7,
        },
      },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

const usage = {
  input_tokens: 5,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 7,
};

/** A scripted model turn that calls one tool: `exec_command` with a command, or a freeform patch. */
const toolCall = (n: number, call: { readonly cmd: string } | { readonly patch: string }) =>
  [
    { type: "response.created", response: { id: `resp_${n}` } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item:
        "cmd" in call
          ? {
              type: "function_call",
              id: `fc_${n}`,
              call_id: `call_${n}`,
              name: "exec_command",
              arguments: JSON.stringify({ cmd: call.cmd }),
            }
          : {
              type: "custom_tool_call",
              id: `ctc_${n}`,
              call_id: `call_${n}`,
              name: "apply_patch",
              input: call.patch,
            },
    },
    { type: "response.completed", response: { id: `resp_${n}`, usage } },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** Running `codex app-server` processes; pgrep exits non-zero when there are none. */
const appServerCount = (): number => {
  try {
    return execFileSync("pgrep", ["-f", "codex app-server"], { encoding: "utf8" })
      .split("\n")
      .filter((pid) => pid !== "").length;
  } catch {
    return 0;
  }
};

/** What a gated bypass run over a scripted model left behind. */
interface GatedRun {
  readonly events: ReadonlyArray<AgentEvent>;
  /** The refs the bare origin ended up with. */
  readonly pushed: string;
  readonly patched: boolean;
  /** How many model calls were made. */
  readonly turns: number;
}

/**
 * Opens a gated bypass thread on a temp gateway home and a repo with a local bare origin, plays
 * `script` as the model's tool calls, and denies every card. `allowRules` is what an earlier
 * "always allow" left in the home; `promptRules` is what the gate installs while the thread opens.
 */
const gatedRun = (run: {
  readonly outwardGate: NonNullable<OpenSessionOptions["outwardGate"]>;
  readonly script: ReadonlyArray<string>;
  readonly allowRules: string;
  readonly promptRules: string;
}): Effect.Effect<GatedRun, unknown> =>
  Effect.gen(function* () {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-live-gate-")));
    const home = join(root, "home");
    const cwd = join(root, "repo");
    const origin = join(root, "origin.git");
    mkdirSync(join(home, "rules"), { recursive: true });
    mkdirSync(cwd);
    git(cwd, "init", "-q", "-b", "work");
    git(cwd, "config", "user.email", "live@example.invalid");
    git(cwd, "config", "user.name", "live");
    git(root, "init", "-q", "--bare", origin);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", "init");
    git(cwd, "remote", "add", "origin", origin);
    writeFileSync(join(home, "rules", "default.rules"), run.allowRules);
    const gateRules = join(home, "rules", "gate.rules");

    let turns = 0;
    const server: Server = createServer((req, res) => {
      req.resume().on("end", () => {
        res
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(run.script[turns++] ?? reply("The push was refused."));
      });
    });
    yield* Effect.promise(
      () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    );
    const port = (server.address() as { port: number }).port;
    const profile = {
      id: ProfileId.make("local"),
      name: "Local",
      baseURL: `http://127.0.0.1:${port}/v1`,
      keyRef: "ref",
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    };
    const layer = CodexHostLive({
      servers: {
        gatewayHome: () => Effect.succeed(home),
        gateRules: {
          install: () => Effect.sync(() => writeFileSync(gateRules, run.promptRules)),
          remove: Effect.sync(() => rmSync(gateRules, { force: true })),
        },
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(GatewayKeyProvider)({
          credentials: () =>
            Effect.succeed({ profile, key: Redacted.make("gram-dummy-not-a-key") }),
        }),
      ),
    );
    const events = yield* Effect.scoped(
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const session = yield* host.open({
          threadId: ThreadId.make("live-gate"),
          cwd,
          model: { agent: "codex", model: "gpt-5.5", profileId: profile.id },
          permissionMode: "bypassPermissions",
          outwardGate: run.outwardGate,
        });
        expect(existsSync(gateRules)).toBe(false);
        yield* session.send({ text: "Commit and push" });
        return yield* session.events.pipe(
          Stream.tap((event: AgentEvent) =>
            event.type === "request"
              ? session.respond(event.request.id, {
                  kind: "approval",
                  decision: "deny",
                  scope: "once",
                })
              : Effect.void,
          ),
          Stream.takeUntil((event: AgentEvent) => event.type === "turnEnd"),
          Stream.runCollect,
        );
      }).pipe(Effect.provide(layer)),
    );
    server.close();
    const pushed = git(origin, "for-each-ref", "--format=%(refname)").trim();
    const patched = existsSync(join(cwd, "b.txt"));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return { events, pushed, patched, turns };
  });

/** One user turn on a thread of a temp gateway home: opened, or resumed from `resumeId`, then closed. */
interface ReopenedTurn {
  readonly resumeId?: string;
  readonly text: string;
  readonly instructions?: string;
  /** Open a new thread rather than resume the first one. */
  readonly fresh?: boolean;
  /** What the user's global `AGENTS.md` says from this open on, copied in as the home refreshes. */
  readonly globalInstructions?: string;
  readonly outwardGate?: NonNullable<OpenSessionOptions["outwardGate"]>;
}

/**
 * Plays `turns` one session after another against the same app-server, which is what a session
 * reload is, with `script` as the model's answers. Every card is denied. Returns each turn's
 * events, the bodies the model was sent, and what `readSession` makes of the thread afterwards,
 * asked from its own folder and from another.
 */
const reopenedRun = (
  script: ReadonlyArray<string>,
  turns: ReadonlyArray<ReopenedTurn>,
  /** Fills the project folder before the first open. */
  setup?: (cwd: string) => void,
) =>
  Effect.gen(function* () {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-live-reopen-")));
    const home = join(root, "home");
    const cwd = join(root, "project");
    mkdirSync(home);
    mkdirSync(cwd);
    setup?.(cwd);
    const bodies: Array<string> = [];
    let globalInstructions: string | undefined;
    const server: Server = createServer((req, res) => {
      let body = "";
      req
        .on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
        .on("end", () => {
          res
            .writeHead(200, { "content-type": "text/event-stream" })
            .end(script[bodies.push(body) - 1] ?? reply("Nothing more."));
        });
    });
    yield* Effect.promise(
      () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    );
    const port = (server.address() as { port: number }).port;
    const profile = {
      id: ProfileId.make("local"),
      name: "Local",
      baseURL: `http://127.0.0.1:${port}/v1`,
      keyRef: "ref",
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    };
    const layer = CodexHostLive({
      servers: {
        gatewayHome: () => Effect.succeed(home),
        refreshGatewayHome: () =>
          Effect.sync(() => {
            if (globalInstructions !== undefined) {
              writeFileSync(join(home, "AGENTS.md"), globalInstructions);
            }
          }),
        gateRules: { install: () => Effect.void, remove: Effect.void },
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(GatewayKeyProvider)({
          credentials: () =>
            Effect.succeed({ profile, key: Redacted.make("gram-dummy-not-a-key") }),
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const host = yield* CodexHost;
      const events: Array<ReadonlyArray<AgentEvent>> = [];
      let threadId: string | undefined;
      for (const turn of turns) {
        globalInstructions = turn.globalInstructions ?? globalInstructions;
        const resumeId = turn.fresh === true ? undefined : threadId;
        const seen = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* host.open({
              threadId: ThreadId.make("live-reopen"),
              cwd,
              model: { agent: "codex", model: "gpt-5.5", profileId: profile.id },
              permissionMode: "bypassPermissions",
              ...(resumeId === undefined ? {} : { resumeId, codexHome: "gateway" }),
              ...(turn.instructions === undefined ? {} : { instructions: turn.instructions }),
              ...(turn.outwardGate === undefined ? {} : { outwardGate: turn.outwardGate }),
            });
            yield* session.send({ text: turn.text });
            return yield* session.events.pipe(
              Stream.tap((event: AgentEvent) =>
                event.type === "request"
                  ? session.respond(event.request.id, {
                      kind: "approval",
                      decision: "deny",
                      scope: "once",
                    })
                  : Effect.void,
              ),
              Stream.takeUntil((event: AgentEvent) => event.type === "turnEnd"),
              Stream.runCollect,
            );
          }),
        );
        threadId ??= seen.flatMap((e) => (e.type === "identity" ? [e.agentSessionId] : []))[0];
        events.push(seen);
      }
      const read = host.readSession!;
      const listed = yield* host.listSessions!({ cwd, limit: 5 });
      const transcript = yield* read({ cwd, agentSessionId: threadId! });
      const elsewhere = yield* Effect.flip(read({ cwd: root, agentSessionId: threadId! }));
      return { events, listed, transcript, elsewhere, threadId };
    }).pipe(Effect.provide(layer));
    server.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return { ...result, bodies, cwd };
  });

/** The developer messages of a Responses API request body, as text. */
const developerText = (body: string): string =>
  (
    JSON.parse(body) as {
      input: ReadonlyArray<{ role?: string; content?: ReadonlyArray<{ text?: string }> }>;
    }
  ).input
    .filter((item) => item.role === "developer")
    .flatMap((item) => (item.content ?? []).map((part) => part.text ?? ""))
    .join("\n");

describe.skipIf(!live)("Codex adapter, live", () => {
  it.live(
    "answers a prompt through the installed codex and stops the app-server on close",
    () =>
      Effect.gen(function* () {
        const server: Server = createServer((req, res) => {
          req.resume().on("end", () => {
            res
              .writeHead(200, { "content-type": "text/event-stream" })
              .end(reply("Hello from Codex."));
          });
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const port = (server.address() as { port: number }).port;
        const home = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-live-")));
        const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-live-project-")));
        const profile = {
          id: ProfileId.make("local"),
          name: "Local",
          baseURL: `http://127.0.0.1:${port}/v1`,
          keyRef: "ref",
          models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
        };
        const before = appServerCount();
        const layer = CodexHostLive({ servers: { extraEnv: { CODEX_HOME: home } } }).pipe(
          Layer.provide(
            Layer.succeed(GatewayKeyProvider)({
              credentials: () =>
                Effect.succeed({ profile, key: Redacted.make("gram-dummy-not-a-key") }),
            }),
          ),
        );
        const events = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* CodexHost;
            const session = yield* host.open({
              threadId: ThreadId.make("live"),
              cwd,
              model: { agent: "codex", model: "gpt-5.5", profileId: profile.id },
            });
            yield* session.send({ text: "Say hello" });
            return yield* session.events.pipe(
              Stream.takeUntil((event: AgentEvent) => event.type === "turnEnd"),
              Stream.runCollect,
            );
          }).pipe(Effect.provide(layer)),
        );
        server.close();
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

        const text = events
          .flatMap((e) =>
            e.type === "chunk" && e.chunk.type === "text-delta" ? [e.chunk.delta] : [],
          )
          .join("");
        expect(text).toBe("Hello from Codex.");
        expect(events.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
        expect(appServerCount()).toBeLessThanOrEqual(before);
      }),
    60_000,
  );

  it.live(
    "GRAM_LIVE_CODEX: under the outward gate in bypass, runs commands and patches unasked, asks once about a push, and carries on when it is denied",
    () =>
      Effect.gen(function* () {
        const { events, pushed, patched, turns } = yield* gatedRun({
          outwardGate: true,
          script: [
            toolCall(0, { cmd: "git status --short" }),
            toolCall(1, { patch: "*** Begin Patch\n*** Add File: b.txt\n+hi\n*** End Patch\n" }),
            toolCall(2, { cmd: "git push origin HEAD:refs/heads/main" }),
          ],
          // What an earlier "always allow" leaves in the home. Alone it runs the push with no
          // request, even under `untrusted`; the gate's prompt rule, there while the thread opens,
          // outranks it.
          allowRules: 'prefix_rule(pattern=["git", "push"], decision="allow")\n',
          promptRules: 'prefix_rule(pattern=["git", "push"], decision="prompt")\n',
        });

        const requests = events.flatMap((e) => (e.type === "request" ? [e.request] : []));
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          kind: "approval",
          input: { command: "git push origin HEAD:refs/heads/main" },
          scopes: ["once"],
        });
        // The thread reads "needs you" once, for the push, not for the command and patch before it.
        const statuses = events.flatMap((e) => (e.type === "status" ? [e.status] : []));
        expect(statuses.filter((status) => status === "awaitingApproval")).toHaveLength(1);
        expect(events[events.findIndex((e) => e.type === "request") - 1]).toEqual({
          type: "status",
          status: "awaitingApproval",
        });
        expect(patched).toBe(true);
        expect(pushed).toBe("");
        // The denied push went back to the model, which answered: all four model calls were made.
        expect(turns).toBe(4);
        expect(events.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
        expect(events.find((e) => e.type === "usage")).toMatchObject({
          tokens: { inputTokens: 20, outputTokens: 8 },
        });
      }),
    90_000,
  );
  it.live(
    "GRAM_LIVE_CODEX: a resumed thread is still told the role it was started with, takes no new one, and reads back",
    () =>
      Effect.gen(function* () {
        const run = yield* reopenedRun(
          [toolCall(0, { cmd: "echo from-the-tool" }), reply("First."), reply("Second.")],
          [
            { text: "one", instructions: "Your role: CODEWORD-PLATYPUS." },
            { text: "two", instructions: "Your role: CODEWORD-WOMBAT." },
          ],
        );
        expect(run.bodies).toHaveLength(3);
        // The role reaches the model on the resumed turn too, out of the thread's own
        // history. What `thread/resume` was given is not what it reads: a thread the app-server
        // still has loaded keeps the instructions it started with.
        const resumed = developerText(run.bodies[2]!);
        expect(resumed).toContain("CODEWORD-PLATYPUS");
        expect(resumed).not.toContain("CODEWORD-WOMBAT");

        // Both homes are asked; only Gram's own has the thread.
        expect(run.listed.map((s) => [s.agentSessionId, s.codexHome])).toEqual([
          [run.threadId, "gateway"],
        ]);
        expect(run.transcript.cwd).toBe(run.cwd);
        expect(
          run.transcript.messages.map(({ role, text, tools }) => ({ role, text, tools })),
        ).toEqual([
          { role: "user", text: "one", tools: undefined },
          {
            role: "assistant",
            text: "",
            tools: [{ name: "Bash", input: "echo from-the-tool", output: "from-the-tool" }],
          },
          { role: "assistant", text: "First.", tools: undefined },
          { role: "user", text: "two", tools: undefined },
          { role: "assistant", text: "Second.", tools: undefined },
        ]);
        expect(run.elsewhere._tag).toBe("NotFound");
      }),
    90_000,
  );
  it.live(
    "GRAM_LIVE_CODEX: a new thread on the same app-server reads the user's global instructions as they now are",
    () =>
      Effect.gen(function* () {
        const run = yield* reopenedRun(
          [reply("First."), reply("Second.")],
          [
            { text: "one", globalInstructions: "Global rule: CODEWORD-HERON." },
            { text: "two", fresh: true, globalInstructions: "Global rule: CODEWORD-EGRET." },
          ],
        );
        expect(run.bodies).toHaveLength(2);
        expect(run.bodies[0]).toContain("CODEWORD-HERON");
        expect(run.bodies[1]).toContain("CODEWORD-EGRET");
        expect(run.bodies[1]).not.toContain("CODEWORD-HERON");
      }),
    90_000,
  );

  it.live(
    "GRAM_LIVE_CODEX: offers the repo's skills and /compact, and runs them as Codex's TUI does",
    () =>
      Effect.gen(function* () {
        const run = yield* reopenedRun(
          [reply("Shipped."), reply("The summary.")],
          [{ text: "/ship-it to staging" }, { text: "/compact" }],
          (cwd) => {
            mkdirSync(join(cwd, ".agents/skills/ship-it"), { recursive: true });
            writeFileSync(
              join(cwd, ".agents/skills/ship-it/SKILL.md"),
              "---\nname: ship-it\ndescription: Ships it\n---\nSKILL-BODY-PELICAN\n",
            );
          },
        );
        const identity = run.events[0]!.find((e) => e.type === "identity");
        expect(identity?.type === "identity" && identity.commands.map((c) => c.name)).toEqual(
          expect.arrayContaining(["compact", "ship-it"]),
        );
        expect(run.bodies[0]).toContain("SKILL-BODY-PELICAN");
        expect(run.bodies[0]).toContain("to staging");
        const markers = run.events[1]!.flatMap((e) =>
          e.type === "chunk" && e.chunk.type === "data-compaction" ? [e.chunk.data.trigger] : [],
        );
        expect(markers).toEqual(["manual"]);
        expect(run.events[1]!.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
      }),
    90_000,
  );
  it.live(
    "GRAM_LIVE_CODEX: a thread reopened under the outward gate asks about a push it would have run unasked",
    () =>
      Effect.gen(function* () {
        const run = yield* reopenedRun(
          [
            reply("First."),
            toolCall(1, { cmd: "git push origin HEAD:refs/heads/main" }),
            reply("The push was refused."),
          ],
          [{ text: "one" }, { text: "push it", outwardGate: "all" }],
        );
        expect(run.events[0]!.some((e) => e.type === "request")).toBe(false);
        const requests = run.events[1]!.flatMap((e) => (e.type === "request" ? [e.request] : []));
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          kind: "approval",
          input: { command: "git push origin HEAD:refs/heads/main" },
          scopes: ["once"],
        });
        expect(run.events[1]!.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
      }),
    90_000,
  );
  it.live(
    "GRAM_LIVE_CODEX: at irreversible in bypass, lets a push land unasked and asks once about the forced one",
    () =>
      Effect.gen(function* () {
        const { events, pushed, turns } = yield* gatedRun({
          outwardGate: "irreversible",
          script: [
            toolCall(0, { cmd: "git push origin HEAD:refs/heads/main" }),
            toolCall(1, { cmd: "git push origin +HEAD:refs/heads/rewritten" }),
          ],
          allowRules: "",
          // No rule names a push at this level: the adapter's reading of the command is what asks.
          promptRules: 'prefix_rule(pattern=["gh", "pr", ["merge", "close"]], decision="prompt")\n',
        });
        const requests = events.flatMap((e) => (e.type === "request" ? [e.request] : []));
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          kind: "approval",
          input: { command: "git push origin +HEAD:refs/heads/rewritten" },
          scopes: ["once"],
        });
        expect(pushed).toBe("refs/heads/main");
        expect(turns).toBe(3);
        expect(events.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
      }),
    90_000,
  );
});

// `GRAM_LIVE_MCP_OAUTH_URL=<an OAuth MCP server>`: the installed `codex` signs in to it, with a person
// finishing the sign-in in the browser this opens. The config lives in a temp CODEX_HOME; the token
// goes wherever Codex keeps MCP credentials (the OS keyring by default), which is the point.
const oauthUrl = process.env["GRAM_LIVE_MCP_OAUTH_URL"];

describe.skipIf(oauthUrl === undefined)(
  "Codex MCP sign-in, live (GRAM_LIVE_MCP_OAUTH_URL, a person signs in)",
  () => {
    it.live(
      "adds the server through Codex, signs in through Codex, and sees it connect with its tools",
      () =>
        Effect.gen(function* () {
          const home = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-oauth-")));
          const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-oauth-project-")));
          const profile = {
            id: ProfileId.make("local"),
            name: "Local",
            baseURL: "http://127.0.0.1:9/v1",
            keyRef: "ref",
            models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
          };
          // `CodexHostLive` with its servers left visible, to read the tools Codex lists afterwards.
          const layer = CodexHostLayer().pipe(
            Layer.provideMerge(CodexServersLive({ extraEnv: { CODEX_HOME: home } })),
            Layer.provide(
              Layer.succeed(GatewayKeyProvider)({
                credentials: () =>
                  Effect.succeed({ profile, key: Redacted.make("gram-dummy-not-a-key") }),
              }),
            ),
          );
          const name = "sb_live_oauth";
          const tools = yield* Effect.scoped(
            Effect.gen(function* () {
              const host = yield* CodexHost;
              yield* host.mcpConfig!.add(
                { cwd, scope: "user", name },
                { type: "http", url: oauthUrl! },
              );
              const session = yield* host.open({
                threadId: ThreadId.make("live-oauth"),
                cwd,
                model: { agent: "codex", model: "gpt-5.5", profileId: profile.id },
              });
              const connectors = session.connectors!;
              const stateOf = connectors.status.pipe(
                Effect.map((all) => all.find((c) => c.name === name)?.status),
              );
              const waitFor = (wanted: string, tries: number) =>
                Effect.gen(function* () {
                  for (let i = 0; i < tries; i++) {
                    if ((yield* stateOf) === wanted) return;
                    yield* Effect.sleep("1 second");
                  }
                  return yield* Effect.die(new Error(`${name} never became ${wanted}`));
                });
              yield* waitFor("needs-auth", 30);

              const started = yield* connectors.authenticate!(name);
              if (started === "started") throw new Error("Codex hands back the page to open");
              yield* runCommand("open", [started.authorizationUrl], { timeoutMs: 10_000 });
              yield* waitFor("connected", 240);

              const server = yield* (yield* CodexServers).acquire(profile.id, "gateway");
              const page = yield* server.rpc.request("mcpServerStatus/list", {
                detail: "toolsAndAuthOnly",
              });
              const status = page.data.find((s) => s.name === name);
              expect(status?.authStatus).toBe("oAuth");
              return Object.keys(status?.tools ?? {});
            }).pipe(Effect.provide(layer)),
          );
          // Codex keys the keyring entry by server name and URL, not by home, so a run that left
          // it behind would find the next one already signed in.
          yield* runCommand("codex", ["mcp", "logout", name], {
            env: { ...(process.env as Record<string, string>), CODEX_HOME: home },
            timeoutMs: 30_000,
          });
          rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
          rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
          console.log(`codex: ${tools.length} tools, e.g. ${tools.slice(0, 5).join(", ")}`);
          expect(tools.length).toBeGreaterThan(0);
        }),
      300_000,
    );
  },
);

// `GRAM_LIVE_MCP_LIST_URL=<an OAuth MCP server>`: what Settings → Connectors asks the installed
// `codex` with no thread, in a temp CODEX_HOME and with nobody at the keyboard. The sign-in is
// started and left: only its page is checked, and nothing is opened.
const listUrl = process.env["GRAM_LIVE_MCP_LIST_URL"];

describe.skipIf(listUrl === undefined)("Codex MCP listing, live (GRAM_LIVE_MCP_LIST_URL)", () => {
  it.live(
    "lists a server offline, its sign-in only when asked, and starts a sign-in with no thread",
    () =>
      Effect.gen(function* () {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-list-")));
        const layer = CodexHostLive({ servers: { extraEnv: { CODEX_HOME: home } } }).pipe(
          Layer.provide(
            Layer.succeed(GatewayKeyProvider)({
              credentials: () => Effect.die("no gateway profile in this test"),
            }),
          ),
        );
        const name = "sb_live_list";
        yield* Effect.scoped(
          Effect.gen(function* () {
            const config = (yield* CodexHost).mcpConfig!;
            yield* config.add(
              { cwd: home, scope: "user", name },
              { type: "http", url: listUrl!, headers: { "X-Gram-Live": "gram-live-header-value" } },
            );

            const quiet = yield* config.list({ checkSignIn: false });
            expect(quiet).toEqual([
              { name, scope: "user", transport: "http", url: listUrl, carriesValues: true },
            ]);
            expect(JSON.stringify(quiet)).not.toContain("gram-live-header-value");

            const asked = yield* config.list({ checkSignIn: true });
            expect(asked[0]?.signedIn).toBe(false);

            const started = yield* config.signIn(name, undefined);
            if (started === "started") throw new Error("Codex hands back the page to open");
            expect(new URL(started.authorizationUrl).protocol).toBe("https:");
            console.log(`codex: sign-in page on ${new URL(started.authorizationUrl).host}`);
          }).pipe(Effect.provide(layer)),
        );
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }),
    120_000,
  );
});
