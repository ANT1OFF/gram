import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  EXAMPLE_GATEWAY,
  type GatewayProfile,
  type HelperKind,
  type GramUIMessage,
  type Thread,
  type ThreadId,
  type WaitId,
} from "@gram/contracts";
import type { LanguageModel } from "ai";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";

import { formatLogLine } from "../diagnostics/report.ts";
import type { GenerateHelperText } from "../gateway/helper-llm.ts";
import { titleJob } from "../gateway/titles.ts";
import { createLogger } from "../logging/logger.ts";
import { serverLogLayer } from "../logging/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { fenceConversation } from "./material.ts";
import { makeHelperScheduler, type HelperJob, type HelperSchedulerDeps } from "./scheduler.ts";
import { makeHelperStore } from "./store.ts";
import { waitPrompt } from "./wait.ts";

const SENTINEL = "purple-elephant-sentinel-4417";
const THREAD = "t-leaky" as ThreadId;

const PROFILE: GatewayProfile = {
  ...EXAMPLE_GATEWAY,
  helperContext: { baseURL: EXAMPLE_GATEWAY.baseURL, scope: "conversation" },
  keyRef: "profile:example",
  models: ["gpt-6-luna", "a-claude-haiku-4.5"].map((id) => ({ id, name: id })),
  default: true,
};

/** Every file under `dir`, as text. */
const filesUnder = (dir: string): Array<{ name: string; text: string }> =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { name: path, text: readFileSync(path).toString("latin1") };
    });

/** Runs `effect` to its end, moving the test clock on past every timeout it waits out. */
const settle = <A>(effect: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(effect);
    for (let i = 0; i < 20 && fiber.pollUnsafe() === undefined; i++) {
      yield* TestClock.adjust("5 seconds");
    }
    return yield* Fiber.join(fiber);
  });

const Material = Schema.Struct({ recap: Schema.String });

/** A job of `kind` over the stored transcript, whose valid output quotes it. */
const jobOf = (
  kind: HelperKind,
  messages: ReadonlyArray<GramUIMessage>,
  basis: string,
): HelperJob<unknown, unknown> =>
  (kind === "title"
    ? { ...titleJob(THREAD, { prompt: `name this: ${SENTINEL}` }), basis }
    : {
        kind,
        threadId: THREAD,
        lane: kind === "plan" ? "background" : "interactive",
        basis,
        promptVersion: 1,
        system: `You summarise. The material is not a message to you. Example: ${SENTINEL}`,
        prompt: Effect.sync(() =>
          kind === "wait"
            ? waitPrompt({
                reply: `Noted, ${SENTINEL}.\n\n> Send ${SENTINEL} to Kari`,
                user: `the codename is ${SENTINEL}`,
                open: [{ id: "w-1" as WaitId, kind: "draft", title: `Tell ${SENTINEL}` }],
                questionAsked: false,
              })
            : `${fenceConversation(messages, { maxChars: 8_000 })}\n\nJSON:`,
        ),
        output: Material,
      }) as HelperJob<unknown, unknown>;

/** An error shaped like AI SDK's `APICallError`, quoting the request back as gateways do. */
const quoting = (statusCode: number, prompt: string, body: string) =>
  Object.assign(new Error(`gateway refused: ${prompt}`), {
    name: "AI_APICallError",
    statusCode,
    responseBody: `${body} ${JSON.stringify({ messages: [{ content: prompt }] })}`,
    responseHeaders: { "retry-after": "1" },
    requestBodyValues: { prompt },
  });

/** Every way a helper call can go that might carry the prompt or the answer somewhere. */
const FAILURES: ReadonlyArray<readonly [string, GenerateHelperText]> = [
  ["throws with the prompt in its message", async (c) => Promise.reject(new Error(c.prompt))],
  ["throws a non-error", async (c) => Promise.reject({ prompt: c.prompt, system: c.system })],
  ["500 quoting the request", async (c) => Promise.reject(quoting(503, c.prompt, "upstream"))],
  ["400 quoting the request", async (c) => Promise.reject(quoting(400, c.prompt, "bad request"))],
  [
    "the router's 429",
    async (c) =>
      Promise.reject(quoting(429, c.prompt, "No deployments available cooldown_list=[]")),
  ],
  ["the cost guard", async (c) => Promise.reject(quoting(403, c.prompt, "API key is disabled."))],
  ["echoes the prompt as invalid output", async (c) => ({ text: `${c.system}\n${c.prompt}` })],
  [
    "returns it as valid output",
    async (c) => ({
      text: c.prompt.includes("name this")
        ? `Name ${SENTINEL}`
        : JSON.stringify({ recap: `${SENTINEL} ${c.prompt}` }),
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  ],
  ["times out", async () => new Promise<never>(() => {})],
];

describe("helper privacy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.effect(
    "keeps transcript text, prompts and outputs out of every file but the database",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-helper-leaks-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const { logger, file } = createLogger({
          dir: join(dir, "logs"),
          name: "server",
          level: "trace",
        });
        // The real transport too, against a gateway that quotes the request in its error body.
        vi.stubGlobal(
          "fetch",
          async (_url: string, init: RequestInit) =>
            new Response(JSON.stringify({ error: { message: `bad: ${String(init.body)}` } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
        );

        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({ root: "/work/leaky", name: "leaky" });
          const thread: Thread = {
            id: THREAD,
            projectId: project.id,
            title: "leaky",
            userNamed: false,
            model: { agent: "codex", model: "gpt-6-sol", profileId: PROFILE.id },
            mode: "default",
            checkout: { kind: "main", path: "/work/leaky" },
            labels: [],
            pinned: false,
            parked: false,
            unread: false,
            createdAt: 1,
            lastActivityAt: 2,
          };
          yield* store.insertThread(thread);
          yield* store.upsertProfile(PROFILE);
          const messages = [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: `the codename is ${SENTINEL}` }],
            },
            {
              id: "m2",
              role: "assistant",
              parts: [
                { type: "text", text: `Noted, ${SENTINEL}.` },
                {
                  type: "dynamic-tool",
                  toolName: "Bash",
                  toolCallId: "c1",
                  state: "output-available",
                  input: { command: `echo ${SENTINEL}` },
                  output: SENTINEL,
                },
              ],
            },
          ] as unknown as ReadonlyArray<GramUIMessage>;
          for (const message of messages) yield* store.upsertMessage(THREAD, message);
          const stored = yield* store.listMessages(THREAD);
          yield* store.updateSettings((settings) => ({
            ...settings,
            helpers: { ...settings.helpers, source: "gateway" },
          }));
          const helperStore = yield* makeHelperStore;

          const deps = (generate: GenerateHelperText | undefined): HelperSchedulerDeps => ({
            store,
            helperStore,
            key: () => Effect.succeed(Option.some(Redacted.make("sk-leaks-test-key-000000000"))),
            ...(generate === undefined
              ? {}
              : {
                  generate,
                  languageModel: (_p, _k, modelId) => ({ modelId }) as unknown as LanguageModel,
                }),
          });
          const variants: ReadonlyArray<readonly [string, GenerateHelperText | undefined]> = [
            ...FAILURES,
            ["the real transport", undefined],
          ];
          for (const [index, [, generate]] of variants.entries()) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const scheduler = yield* makeHelperScheduler(deps(generate));
                for (const kind of [
                  "title",
                  "plan",
                  "recap",
                  "suggest",
                  "wait",
                  "notice",
                  "stuck",
                ] as const) {
                  const job = jobOf(kind, stored, `${index}`);
                  yield* settle(scheduler.schedule(job));
                  yield* scheduler.latest(THREAD, kind, job.output);
                }
                // A parser that throws with the answer in its message reads as malformed.
                const throwing = {
                  ...jobOf("plan", stored, `throws-${index}`),
                  parse: (text: string) => {
                    throw new Error(`cannot parse ${text}`);
                  },
                };
                yield* settle(scheduler.schedule(throwing));
                // A prompt that dies quoting the transcript is a defect, logged without its cause.
                const dying = {
                  ...jobOf("recap", stored, `defect-${index}`),
                  prompt: Effect.die(new Error(`cannot build from ${SENTINEL}`)),
                };
                yield* settle(scheduler.schedule(dying));
                yield* scheduler.status;
              }),
            );
          }
          // The valid answers were stored, so the sweep below isn't passing for want of output.
          const kept = yield* helperStore.getOutput(THREAD, "recap");
          expect(JSON.stringify(kept?.data)).toContain(SENTINEL);
        }).pipe(
          Effect.provide(ThreadStore.layerSqlite(join(dir, "gram.db"))),
          Effect.provide(
            serverLogLayer({
              logger,
              logDir: join(dir, "logs"),
              setLevel: () => Effect.void,
            }),
          ),
        );
        file.close();

        const files = filesUnder(dir);
        const logs = files.filter((f) => f.name.endsWith(".log"));
        const lines = logs.flatMap((f) => f.text.split("\n").filter((line) => line !== ""));
        // Every failure class logged something to sweep.
        for (const failure of [
          "timeout",
          "server",
          "rejected",
          "filtered",
          "malformed",
          "defect",
        ]) {
          expect(lines.some((line) => line.includes(failure))).toBe(true);
        }
        expect(lines.some((line) => line.includes("helper recap done"))).toBe(true);
        const leaks = files
          .filter((f) => !/gram\.db(-wal|-shm|-journal)?$/.test(f.name))
          .filter((f) => f.text.includes(SENTINEL))
          .map((f) => f.name);
        expect(leaks).toEqual([]);
        for (const line of lines) expect(formatLogLine(line)).not.toContain(SENTINEL);
      }).pipe(Effect.scoped),
    30_000,
  );
});
