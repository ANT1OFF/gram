import { describe, expect, it } from "@effect/vitest";
import { AgentUnavailable, ThreadId, type AgentEvent } from "@gram/contracts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { AgentHost } from "./host.ts";
import { GatewayKeyProvider } from "./gateway.ts";
import { ClaudeHostLive } from "./claude/live.ts";
import { ClaudeHost } from "./claude/session.ts";
import { CodexHostLive } from "./codex/live.ts";
import { CodexHost } from "./codex/session.ts";

// Explicit opt-in only: uses the desktop's existing CLI login and makes two tiny provider turns.
// Never run this as ordinary CI, copy credentials, or infer a plan tier from a successful reply.
const enabled = new Set((process.env["GRAM_LIVE_SUBSCRIPTIONS"] ?? "").split(","));
const keys = Layer.succeed(GatewayKeyProvider)({
  credentials: () =>
    Effect.fail(
      new AgentUnavailable({ agent: "codex", message: "Subscription acceptance uses no gateway." }),
    ),
});

for (const agent of ["claude", "codex"] as const) {
  describe.skipIf(!enabled.has(agent))(`${agent}: installed subscription CLI acceptance`, () => {
    it.live(
      "discovers local models, streams a turn, and resumes the same session",
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gram-subscription-acceptance-")));
            execFileSync("git", ["init", "--quiet", cwd]);
            return cwd;
          }),
          (cwd) => {
            const run = (host: AgentHost) =>
              Effect.gen(function* () {
                const models = yield* host.listModels!();
                expect(models.length).toBeGreaterThan(0);
                const model = models.find((m) => m.isDefault) ?? models[0]!;
                let sessionId = "";
                for (let turn = 0; turn < 2; turn++) {
                  yield* Effect.scoped(
                    Effect.gen(function* () {
                      const session = yield* host.open({
                        threadId: ThreadId.make("subscription-acceptance"),
                        cwd,
                        model: { agent, model: model.id },
                        confineWrites: process.env["GRAM_LIVE_CONFINED"] === "1",
                        ...(turn === 0 ? {} : { resumeId: sessionId }),
                      });
                      yield* session.send({
                        text: "Reply with exactly GRAM_SUBSCRIPTION_OK. Do not use any tools.",
                      });
                      const events = yield* session.events.pipe(
                        Stream.tap((e: AgentEvent) =>
                          e.type === "request"
                            ? session.respond(e.request.id, {
                                kind: "approval",
                                decision: "deny",
                                scope: "once",
                              })
                            : Effect.void,
                        ),
                        Stream.takeUntil((e) => e.type === "turnEnd" || e.type === "ended"),
                        Stream.runCollect,
                      );
                      const text = events
                        .flatMap((e) =>
                          e.type === "chunk" && e.chunk.type === "text-delta"
                            ? [e.chunk.delta]
                            : [],
                        )
                        .join("");
                      const terminal = events.at(-1);
                      console.info(
                        JSON.stringify({
                          agent,
                          turn,
                          textReceived: text.length > 0,
                          terminal: terminal?.type,
                          ...(terminal?.type === "turnEnd"
                            ? { reason: terminal.reason, failure: terminal.failure }
                            : {}),
                        }),
                      );
                      // Boolean assertions avoid dumping account, provider output, or session ids on failure.
                      expect(text.includes("GRAM_SUBSCRIPTION_OK")).toBe(true);
                      const last = events.at(-1);
                      expect(last?.type === "turnEnd" && last.reason === "completed").toBe(true);
                      const identity = events.find((e) => e.type === "identity");
                      expect(identity?.type === "identity").toBe(true);
                      if (identity?.type === "identity") {
                        if (turn === 0) sessionId = identity.agentSessionId;
                        else expect(identity.agentSessionId === sessionId).toBe(true);
                      }
                    }),
                  );
                }
              });
            return Effect.scoped(
              agent === "claude"
                ? Effect.flatMap(ClaudeHost, run).pipe(
                    Effect.provide(
                      ClaudeHostLive({
                        settingSources: [],
                        environment: process.env["GRAM_LIVE_CLAUDE_BINARY"]
                          ? { binaryPath: process.env["GRAM_LIVE_CLAUDE_BINARY"] }
                          : {},
                      }),
                    ),
                  )
                : Effect.flatMap(CodexHost, run).pipe(
                    Effect.provide(
                      CodexHostLive({
                        servers: process.env["GRAM_LIVE_CODEX_BINARY"]
                          ? { binaryPath: process.env["GRAM_LIVE_CODEX_BINARY"] }
                          : {},
                      }).pipe(Layer.provide(keys)),
                    ),
                  ),
            ).pipe(Effect.timeout("90 seconds"));
          },
          (cwd) =>
            Effect.sync(() =>
              rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
            ),
        ),
      100000,
    );
  });
}

// Separate opt-in: one search turn, never part of the two-turn subscription smoke test.
// It inherits the user's search policy; do not add an always-on override to make this pass.
describe.skipIf(process.env["GRAM_LIVE_CODEX_WEB_SEARCH"] !== "1")(
  "codex: installed built-in web search",
  () => {
    it.live(
      "can search with plugins/apps disabled for MCP confinement",
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gram-web-search-acceptance-")));
            execFileSync("git", ["init", "--quiet", cwd]);
            return cwd;
          }),
          (cwd) =>
            Effect.scoped(
              Effect.flatMap(CodexHost, (host) =>
                Effect.gen(function* () {
                  const models = yield* host.listModels!();
                  const model =
                    models.find((m) => /luna/i.test(m.displayName)) ??
                    models.find((m) => m.isDefault) ??
                    models[0]!;
                  const session = yield* host.open({
                    threadId: ThreadId.make("web-search-acceptance"),
                    cwd,
                    model: { agent: "codex", model: model.id },
                    confineWrites: true,
                  });
                  yield* session.send({
                    text: "Use built-in web search once to find the official Codex configuration basics page on developers.openai.com or learn.chatgpt.com. Do not use shell, file, MCP or other tools. Reply WEB-SEARCH-OK and the page URL, briefly.",
                  });
                  const events = yield* session.events.pipe(
                    Stream.tap((e) =>
                      e.type === "request"
                        ? session.respond(e.request.id, {
                            kind: "approval",
                            decision: "deny",
                            scope: "once",
                          })
                        : Effect.void,
                    ),
                    Stream.takeUntil((e) => e.type === "turnEnd" || e.type === "ended"),
                    Stream.runCollect,
                  );
                  const searched = events.some(
                    (e) =>
                      e.type === "chunk" &&
                      e.chunk.type === "tool-input-available" &&
                      e.chunk.toolName === "WebSearch",
                  );
                  const last = events.at(-1);
                  console.info(
                    JSON.stringify({
                      agent: "codex",
                      webSearchObserved: searched,
                      completed: last?.type === "turnEnd" && last.reason === "completed",
                    }),
                  );
                  expect(searched).toBe(true);
                  expect(last?.type === "turnEnd" && last.reason === "completed").toBe(true);
                }),
              ).pipe(
                Effect.provide(
                  CodexHostLive({
                    servers: process.env["GRAM_LIVE_CODEX_BINARY"]
                      ? { binaryPath: process.env["GRAM_LIVE_CODEX_BINARY"] }
                      : {},
                  }).pipe(Layer.provide(keys)),
                ),
              ),
            ).pipe(Effect.timeout("60 seconds")),
          (cwd) =>
            Effect.sync(() =>
              rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
            ),
        ),
      70000,
    );
  },
);
