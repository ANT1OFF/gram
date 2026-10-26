import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type {
  GatewayProfile,
  ProfileId,
  SlashCommand,
  GramUIMessage,
  Thread,
  ThreadId,
} from "@gram/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { afterEach } from "vitest";

import {
  catalogUrl,
  discoverModels,
  mergeModels,
  parseModelIds,
  parseModelInfo,
  type Fetcher,
} from "./discovery.ts";
import {
  makeBridgeVault,
  makeMemoryVault,
  type VaultPort,
  type VaultRequest,
} from "./key-vault.ts";
import { profilesFromCodex, profilesFromOpenCode, readOpenCodeKey, seedProfiles } from "./seed.ts";
import {
  cleanTitle,
  hasDefaultTitle,
  heuristicTitle,
  isCommand,
  openingOf,
  runTitleWatcher,
  titlePhase,
  type TitleMoment,
} from "./titles.ts";

const SECRET = "sk-test-secret-value";
const profile = (overrides: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: "litellm" as ProfileId,
  name: "LiteLLM",
  baseURL: "https://gateway.example/v1/",
  keyRef: "profile:litellm",
  models: [],
  ...overrides,
});

const temps: Array<string> = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-gateway-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("key vaults", () => {
  it.effect("the memory vault sets, gets and removes keys", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault();
      expect(vault.kind).toBe("memory");
      expect(Option.isNone(yield* vault.get("profile:a"))).toBe(true);
      yield* vault.set("profile:a", Redacted.make(SECRET));
      const got = yield* vault.get("profile:a");
      expect(Option.map(got, Redacted.value)).toEqual(Option.some(SECRET));
      yield* vault.remove("profile:a");
      expect(Option.isNone(yield* vault.get("profile:a"))).toBe(true);
    }),
  );

  it.effect("the bridge asks the parent port and maps its answers", () =>
    Effect.gen(function* () {
      const listeners: Array<(event: { data: unknown }) => void> = [];
      const store = new Map<string, string>();
      const reply = (data: unknown) => queueMicrotask(() => listeners.forEach((l) => l({ data })));
      const port: VaultPort = {
        on: (_event, listener) => listeners.push(listener),
        postMessage: (message) => {
          const request = message as VaultRequest;
          if (request.op === "set") {
            store.set(request.ref, request.value);
            reply({ type: "vault.response", id: request.id, ok: true });
          } else if (request.op === "get") {
            const value = store.get(request.ref);
            reply({
              type: "vault.response",
              id: request.id,
              ok: true,
              ...(value === undefined ? {} : { value }),
            });
          } else {
            reply({
              type: "vault.response",
              id: request.id,
              ok: false,
              message: "encryption unavailable",
            });
          }
        },
      };
      const vault = makeBridgeVault(port);
      yield* vault.set("profile:a", Redacted.make(SECRET));
      expect(Option.map(yield* vault.get("profile:a"), Redacted.value)).toEqual(
        Option.some(SECRET),
      );
      const failure = yield* Effect.flip(vault.remove("profile:a"));
      expect(failure.message).toBe("encryption unavailable");
    }),
  );

  it.effect("the bridge times out when nobody answers", () =>
    Effect.gen(function* () {
      const vault = makeBridgeVault({ on: () => undefined, postMessage: () => undefined }, 20);
      expect((yield* Effect.flip(vault.get("profile:a"))).message).toContain("didn't answer");
    }),
  );
});

/** A fetcher answering `status` with `body`, recording each request's URL and auth header. */
const respond =
  (
    status: number,
    body: unknown,
    seen: Array<{ url: string; auth: string | undefined }> = [],
  ): Fetcher =>
  async (url, init) => {
    seen.push({ url, auth: init.headers["Authorization"] });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };

/** A gateway whose proxy lists `unlisted` and whose platform catalog is down. */
const catalogDown: Fetcher = async (url) =>
  url === "https://gateway.example.invalid/v1/models"
    ? { ok: true, status: 200, json: async () => ({ data: [{ id: "unlisted" }] }) }
    : { ok: false, status: 503, json: async () => ({}) };

describe("model discovery", () => {
  it("parses OpenAI-style lists and keeps overrides for known ids", () => {
    expect(parseModelIds({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { nope: 1 }] })).toEqual([
      "b",
      "a",
    ]);
    expect(parseModelIds([{ id: "x" }])).toEqual(["x"]);
    expect(parseModelIds({ models: [] })).toBeNull();
    expect(
      mergeModels(
        [{ id: "a", name: "Model A", contextWindow: 200_000, variants: ["low"] }],
        ["a", "c"],
      ),
    ).toEqual([
      { id: "a", name: "Model A", contextWindow: 200_000, variants: ["low"] },
      { id: "c", name: "c" },
    ]);
  });

  it.effect("calls {baseURL}/models with the key and returns merged models", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const models = yield* discoverModels(
        profile({ models: [{ id: "gpt", name: "GPT" }] }),
        Redacted.make(SECRET),
        respond(200, { data: [{ id: "gpt" }, { id: "claude" }] }, seen),
      );
      expect(seen).toEqual([
        { url: "https://gateway.example/v1/models", auth: `Bearer ${SECRET}` },
      ]);
      expect(models.map((m) => m.name)).toEqual(["GPT", "claude"]);
    }),
  );

  // EXAMPLE's platform catalog as `serialize_model_info` shapes it, for a sample of its routes.
  const platformModels: unknown = JSON.parse(
    readFileSync(new URL("./fixtures/example-platform-models.json", import.meta.url), "utf8"),
  );

  it("reads only an explicitly configured HTTPS metadata catalog", () => {
    expect(catalogUrl({})).toBeUndefined();
    expect(catalogUrl({ modelCatalogURL: "https://metadata.example.test/models" })).toBe(
      "https://metadata.example.test/models",
    );
    for (const modelCatalogURL of [
      "http://metadata.example.test",
      "https://key@metadata.example.test",
      "invalid",
    ])
      expect(catalogUrl({ modelCatalogURL })).toBeUndefined();
    const infos = parseModelInfo(platformModels)!;
    expect(infos.get("gpt-6.1-sol")).toEqual({
      mode: "chat",
      deprecated: false,
      restricted: false,
      tools: true,
      reasoning: true,
      noneEffort: false,
      xhighEffort: true,
      maxEffort: true,
      webSearch: false,
      maxInputTokens: 922_000,
    });
    expect(infos.get("a-claude-haiku-4.5")).toMatchObject({ xhighEffort: false, webSearch: true });
    // Haiku 5.5 always thinks, which the catalog says outside `supports`: no `none` effort.
    expect(infos.get("claude-haiku-5.5-eu")).toEqual({
      mode: "chat",
      deprecated: false,
      restricted: false,
      tools: true,
      reasoning: true,
      noneEffort: false,
      xhighEffort: true,
      maxEffort: true,
      webSearch: false,
      maxInputTokens: 1_000_000,
    });
    expect(infos.get("a-claude-haiku-5.5")).toMatchObject({ noneEffort: false, webSearch: true });
    expect(infos.get("jev-1.13")).toEqual({
      mode: "evaluation",
      deprecated: false,
      restricted: true,
      maxInputTokens: 32_000,
    });
    expect(parseModelInfo({ data: [] })).toBeNull();
  });

  it.effect("describes each model from the platform catalog, without sending it the key", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const fetcher: Fetcher = async (url, init) => {
        seen.push({ url, auth: init.headers["Authorization"] });
        const body =
          url === "https://gateway.example.invalid/v1/models"
            ? { data: [{ id: "gpt-6.1-sol" }, { id: "unlisted" }] }
            : platformModels;
        return { ok: true, status: 200, json: async () => body };
      };
      const example = profile({
        baseURL: "https://gateway.example.invalid/v1",
        modelCatalogURL: "https://metadata.example.test/models",
        models: [{ id: "unlisted", name: "Mine", info: { reasoning: false } }],
      });
      const models = yield* discoverModels(example, Redacted.make(SECRET), fetcher);
      expect(seen).toEqual([
        { url: "https://gateway.example.invalid/v1/models", auth: `Bearer ${SECRET}` },
        {
          url: "https://metadata.example.test/models",
          auth: undefined,
        },
      ]);
      expect(models[0]?.info).toMatchObject({ noneEffort: false, maxEffort: true });
      // The catalog no longer describes it, so the old description goes.
      expect(models[1]).toEqual({ id: "unlisted", name: "Mine" });

      // A catalog that can't be read leaves the models as they were described.
      expect(yield* discoverModels(example, Redacted.make(SECRET), catalogDown)).toEqual(
        example.models,
      );
    }),
  );

  it.effect("reports failures by host without leaking the key", () =>
    Effect.gen(function* () {
      const cases: Array<[Fetcher, string]> = [
        [respond(401, {}), "rejected the key (401)"],
        [respond(502, {}), "answered 502"],
        [respond(200, { unexpected: true }), "isn't in the OpenAI format"],
        [async () => Promise.reject(new Error(`boom ${SECRET}`)), "Couldn't reach gateway.example"],
      ];
      for (const [fetcher, expected] of cases) {
        const error = yield* Effect.flip(discoverModels(profile(), Redacted.make(SECRET), fetcher));
        expect(error.message).toContain(expected);
        expect(error.message).not.toContain(SECRET);
      }
    }),
  );
});

describe("seeding", () => {
  const openCodeConfig = {
    provider: {
      litellm: {
        name: "EXAMPLE LiteLLM",
        options: { baseURL: "https://llm.example/v1/proxy" },
        models: {
          "gpt-5": {
            name: "GPT-5",
            limit: { context: 400_000 },
            variants: { low: {}, high: {}, weird: {} },
          },
          plain: {},
        },
      },
      nourl: { options: {} },
    },
  };

  it("maps OpenCode providers and Codex model providers without keys", () => {
    expect(profilesFromOpenCode(openCodeConfig)).toEqual([
      {
        id: "opencode-litellm",
        name: "EXAMPLE LiteLLM",
        baseURL: "https://llm.example/v1/proxy",
        keyRef: "",
        models: [
          { id: "gpt-5", name: "GPT-5", contextWindow: 400_000, variants: ["low", "high"] },
          { id: "plain", name: "plain" },
        ],
      },
    ]);
    expect(
      profilesFromCodex({
        model: "gpt-5.5",
        model_provider: "example",
        model_providers: {
          example: { name: "EXAMPLE", base_url: "https://other.example/v1" },
          off: { name: "x" },
        },
      }),
    ).toEqual([
      {
        id: "codex-example",
        name: "EXAMPLE",
        baseURL: "https://other.example/v1",
        keyRef: "",
        models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
      },
    ]);
  });

  it.effect(
    "seeds from a home dir, skips a Codex duplicate of an OpenCode URL, marks the first default",
    () =>
      Effect.gen(function* () {
        const home = tempDir();
        mkdirSync(join(home, ".config", "opencode"), { recursive: true });
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(
          join(home, ".config", "opencode", "opencode.json"),
          JSON.stringify(openCodeConfig),
        );
        writeFileSync(
          join(home, ".codex", "config.toml"),
          'model_provider = "example"\n[model_providers.example]\nname = "EXAMPLE"\nbase_url = "https://llm.example/v1/proxy/"\n[model_providers.work]\nbase_url = "https://work.example/v1"\n',
        );
        const profiles = yield* seedProfiles(home);
        expect(profiles.map((p) => [p.id, p.default ?? false])).toEqual([
          ["opencode-litellm", true],
          ["codex-work", false],
        ]);
        expect(profiles.every((p) => p.keyRef === "")).toBe(true);
        expect(yield* seedProfiles(tempDir())).toEqual([]);
      }),
  );

  it.effect("reads OpenCode's key for the provider on the same base URL", () =>
    Effect.gen(function* () {
      const home = tempDir();
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
      writeFileSync(
        join(home, ".config", "opencode", "opencode.json"),
        JSON.stringify(openCodeConfig),
      );
      writeFileSync(
        join(home, ".local", "share", "opencode", "auth.json"),
        JSON.stringify({ litellm: { type: "api", key: SECRET } }),
      );
      const key = yield* readOpenCodeKey(home, "https://llm.example/v1/proxy/");
      expect(Option.map(key, Redacted.value)).toEqual(Option.some(SECRET));
      expect(Option.isNone(yield* readOpenCodeKey(home, "https://unknown.example"))).toBe(true);
    }),
  );
});

describe("helper titles", () => {
  it("cleans model output into a title", () => {
    expect(cleanTitle("# Investigate the failing check")).toBe("Investigate the failing check");
    // A model that answered the conversation instead of naming it.
    expect(
      cleanTitle("I don't have access to your repositories or pull requests. I can't browse them."),
    ).toBeUndefined();
    expect(cleanTitle("Title: Refactor auth flow.")).toBe("Refactor auth flow");
    expect(cleanTitle("\n\n  “Speed up CI”  ")).toBe("Speed up CI");
    expect(cleanTitle("   ")).toBeUndefined();
  });
});

const text = (id: string, role: "user" | "assistant", value: string, turnId?: string) =>
  ({
    id,
    role,
    parts: [{ type: "text", text: value }],
    ...(turnId === undefined ? {} : { metadata: { turnId } }),
  }) as unknown as GramUIMessage;

/** What a session reports: `/model` and `/clear`, which also answers to `/reset`. */
const COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "model", description: "" },
  { name: "clear", description: "", aliases: ["reset"] },
];

/** A first exchange: the user's opener and a one-word reply. */
const exchange = (opener: string): ReadonlyArray<GramUIMessage> => [
  text("m1", "user", opener),
  text("m2", "assistant", "Sure."),
];

describe("title watcher", () => {
  const THREAD = "thread-1" as ThreadId;
  // Long enough to be named from alone; `SHORT` isn't.
  const prompt =
    "please add a gateway settings page where a profile's key, models and default can be managed\nwith details";
  const SHORT = "yes, push and open the PR";
  const thread = (overrides: Partial<Thread> = {}, opener = prompt): Thread =>
    ({ id: THREAD, title: heuristicTitle(opener), userNamed: false, ...overrides }) as Thread;

  const run = (
    initial: Thread,
    turns: number,
    titles: ReadonlyArray<Option.Option<string>>,
    phases: ReadonlyArray<TitleMoment["phase"]> = ["settled", "settled"],
    options: {
      readonly opener?: string;
      readonly rename?: Partial<Thread>;
      /** The turn count once the first call is out: a queued message has started turn two. */
      readonly turnsLater?: number;
      /** The turn stops with nothing from the agent. */
      readonly silent?: boolean;
      /** The whole transcript, in place of `opener` and its one-word reply. */
      readonly messages?: ReadonlyArray<GramUIMessage>;
      /** The session hasn't said what its commands are yet. */
      readonly commandsUnknown?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      let current = initial;
      const messages = options.messages ?? exchange(options.opener ?? prompt);
      const calls: Array<{ readonly prompt: string; readonly reply?: string }> = [];
      const moments = yield* Queue.unbounded<TitleMoment, Cause.Done>();
      yield* Queue.offerAll(
        moments,
        phases.map((phase) => ({ threadId: THREAD, phase })),
      );
      yield* Queue.end(moments);
      yield* runTitleWatcher({
        helper: {
          title: (_threadId, input) =>
            Effect.sync(() => {
              calls.push(input);
              // Someone renaming the thread while the first call is out.
              if (calls.length === 1 && options.rename) current = { ...current, ...options.rename };
              return titles[calls.length - 1] ?? Option.none();
            }),
        },
        moments: Stream.fromQueue(moments),
        getThread: () => Effect.sync(() => current),
        turnCount: () =>
          Effect.sync(() => (calls.length === 0 ? turns : (options.turnsLater ?? turns))),
        // The reply exists only once the turn has ended, which is after the first attempt.
        messages: () =>
          Effect.sync(() =>
            options.messages === undefined && (calls.length === 0 || options.silent)
              ? messages.slice(0, 1)
              : messages,
          ),
        commands: () => Effect.succeed(options.commandsUnknown ? undefined : COMMANDS),
        updateThread: (_id, f) => Effect.sync(() => void (current = f(current))),
      });
      return { current, helperCalls: calls.length, calls };
    });

  it.effect("titles a thread after its first turn, once", () =>
    Effect.gen(function* () {
      const { current, helperCalls } = yield* run(thread(), 1, [
        Option.some("Gateway settings page"),
      ]);
      expect(current.title).toBe("Gateway settings page");
      expect(helperCalls).toBe(1);
    }),
  );

  it.effect("forgets a removed thread, so it keeps nothing per thread ever seen", () =>
    Effect.gen(function* () {
      // An early try that got nothing is remembered, so the next "started" asks no more...
      const kept = yield* run(thread(), 1, [Option.none(), Option.none()], ["started", "started"]);
      expect(kept.helperCalls).toBe(1);
      // A removal asks nothing itself...
      const removed = yield* run(thread(), 1, [Option.none()], ["started", "removed"]);
      expect(removed.helperCalls).toBe(1);
      // ...and lets go of the thread (shown by a "started" after it).
      const forgotten = yield* run(
        thread(),
        1,
        [Option.none(), Option.none()],
        ["started", "removed", "started"],
      );
      expect(forgotten.helperCalls).toBe(2);
    }),
  );

  it.effect("titles from the prompt alone as the first turn starts, and asks no more", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread(),
        1,
        [Option.some("Gateway settings page")],
        ["started", "started", "settled"],
      );
      expect(current.title).toBe("Gateway settings page");
      expect(calls).toEqual([{ prompt }]);
    }),
  );

  it.effect("names a short opener again once there is a reply to go on", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread({}, SHORT),
        1,
        [Option.some("Push and open PR"), Option.some("Open the zoom shortcut PR")],
        ["started", "started", "settled", "settled"],
        { opener: SHORT },
      );
      expect(current.title).toBe("Open the zoom shortcut PR");
      expect(calls).toEqual([{ prompt: SHORT }, { prompt: SHORT, reply: "Sure." }]);
    }),
  );

  it.effect("still names a short opener again when a queued message has started turn two", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread({}, SHORT),
        1,
        [Option.some("Push and open PR"), Option.some("Open the zoom shortcut PR")],
        ["started", "settled"],
        { opener: SHORT, turnsLater: 2 },
      );
      expect(current.title).toBe("Open the zoom shortcut PR");
      expect(calls).toHaveLength(2);
    }),
  );

  it.effect("doesn't ask again about a short opener whose turn stopped without a reply", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread({}, SHORT),
        1,
        [Option.some("Push and open PR"), Option.some("x")],
        ["started", "settled"],
        { opener: SHORT, silent: true },
      );
      expect(current.title).toBe("Push and open PR");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("leaves the agent's title alone even when it is word for word the helper's", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread({}, SHORT),
        1,
        [Option.some("Push and open PR"), Option.some("x")],
        ["started", "settled"],
        { opener: SHORT, rename: { title: "Push and open PR", agentNamed: true } },
      );
      expect(current).toMatchObject({ title: "Push and open PR", agentNamed: true });
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("leaves a title changed after its first one alone, and doesn't ask", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread({}, SHORT),
        1,
        [Option.some("Push and open PR"), Option.some("x")],
        ["started", "settled"],
        { opener: SHORT, rename: { title: "Set by set_title" } },
      );
      expect(current.title).toBe("Set by set_title");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("asks again with the reply when the turn ends, if the first try had nothing", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread(),
        1,
        [Option.none(), Option.some("Gateway settings page")],
        // `running` is reported many times a turn; only the first is an attempt.
        ["started", "started", "started", "settled", "settled"],
      );
      expect(current.title).toBe("Gateway settings page");
      expect(calls).toEqual([{ prompt }, { prompt, reply: "Sure." }]);
    }),
  );

  it.effect("names a thread that was opened empty and typed into later", () =>
    Effect.gen(function* () {
      const { current, calls } = yield* run(
        thread({ title: heuristicTitle(undefined) }),
        1,
        [Option.some("Gateway settings page")],
        ["started", "settled"],
      );
      expect(current.title).toBe("Gateway settings page");
      expect(calls).toEqual([{ prompt }]);
    }),
  );

  it.effect("names a thread opened with a command from the message after it", () =>
    Effect.gen(function* () {
      const command = "/model claude-opus";
      const commandOnly = [text("m1", "user", command), text("m2", "assistant", "Model set.")];
      const opened = [...commandOnly, text("m3", "user", SHORT), text("m4", "assistant", "Sure.")];

      // The command's own turn is not the one to name, and doesn't use the attempt up.
      const before = yield* run(
        thread({}, command),
        1,
        [Option.some("x")],
        ["started", "settled"],
        {
          messages: commandOnly,
        },
      );
      expect(before.helperCalls).toBe(0);

      const { current, calls } = yield* run(
        thread({}, command),
        2,
        [Option.some("Open the zoom shortcut PR")],
        ["settled"],
        { messages: opened },
      );
      expect(current.title).toBe("Open the zoom shortcut PR");
      expect(calls).toEqual([{ prompt: SHORT, reply: "Sure." }]);
      // Turn two of a thread that opened with a real message is still nobody's to name.
      expect((yield* run(thread(), 2, [Option.some("x")])).helperCalls).toBe(0);

      expect(openingOf(commandOnly, COMMANDS)).toBeUndefined();
    }),
  );

  it.effect("names the message steered into a leading command's turn", () =>
    Effect.gen(function* () {
      const command = "/model claude-opus";
      // One turn holds both: the steer is stored as a second user message with the same turn id.
      const steered = [
        text("m1", "user", command, "turn-1"),
        text("m2", "user", SHORT, "turn-1"),
        text("m3", "assistant", "Sure."),
      ];
      const { current, calls } = yield* run(
        thread({}, command),
        1,
        [Option.some("Open the zoom shortcut PR")],
        ["settled"],
        { messages: steered },
      );
      expect(current.title).toBe("Open the zoom shortcut PR");
      expect(calls).toEqual([{ prompt: SHORT, reply: "Sure." }]);
      expect(openingOf(steered, COMMANDS)?.turnsBefore).toBe(0);
      // Two commands in one turn, then the prompt in the next: one turn before it, not two.
      const twoInOne = [
        text("m1", "user", command, "turn-1"),
        text("m2", "user", "/reset", "turn-1"),
        text("m3", "user", SHORT, "turn-2"),
      ];
      expect(openingOf(twoInOne, COMMANDS)).toMatchObject({ prompt: SHORT, turnsBefore: 1 });
    }),
  );

  it.effect("takes a prompt that opens with a path for a prompt", () =>
    Effect.gen(function* () {
      const path =
        "/tmp is full again, find out what keeps writing to it and stop it from doing so";
      expect(isCommand(path, COMMANDS)).toBe(false);
      expect(isCommand("/reset", COMMANDS)).toBe(true);
      expect(isCommand("/Users/me/repo has a failing build", undefined)).toBe(false);

      const known = yield* run(
        thread({}, path),
        1,
        [Option.some("Find what fills tmp")],
        ["started"],
        {
          opener: path,
        },
      );
      expect(known.current.title).toBe("Find what fills tmp");

      // Before the session has listed its commands the early title is skipped, not the thread:
      // the turn's end, by when they are known, still names it.
      const early = yield* run(thread({}, path), 1, [Option.some("x")], ["started"], {
        opener: path,
        commandsUnknown: true,
      });
      expect(early.helperCalls).toBe(0);
      const late = yield* run(
        thread({}, path),
        1,
        [Option.some("Find what fills tmp")],
        ["settled"],
        { opener: path },
      );
      expect(late.current.title).toBe("Find what fills tmp");
    }),
  );

  it("counts every way a turn stops as settled, and only `running` as started", () => {
    expect(titlePhase("running")).toBe("started");
    for (const status of ["idle", "error", "ended", "cold"] as const) {
      expect(titlePhase(status)).toBe("settled");
    }
    for (const status of ["starting", "needsApproval", "needsInput"] as const) {
      expect(titlePhase(status)).toBeUndefined();
    }
  });

  it.effect("leaves user- or agent-named threads, later turns and helper misses alone", () =>
    Effect.gen(function* () {
      const some = [Option.some("x")];
      expect((yield* run(thread({ userNamed: true }), 1, some)).helperCalls).toBe(0);
      expect((yield* run(thread({ title: "Set by set_title" }), 1, some)).current.title).toBe(
        "Set by set_title",
      );
      expect((yield* run(thread(), 2, some)).helperCalls).toBe(0);
      expect((yield* run(thread(), 1, [Option.none()])).current.title).toBe(heuristicTitle(prompt));
      expect(hasDefaultTitle(thread(), prompt)).toBe(true);
    }),
  );
});
