import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, layer } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import { makeGrokHost } from "@gram/agents/grok";
import {
  AgentUnavailable,
  GatewayError,
  NotFound,
  type GatewayProfile,
  type ProfileId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { afterAll } from "vitest";

import type { Fetcher } from "../../gateway/discovery.ts";
import { makeMemoryVault, VaultError } from "../../gateway/key-vault.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import { makeGateway } from "./gateway.ts";

const SECRET = "sk-handler-secret";
const home = mkdtempSync(join(tmpdir(), "gram-gateway-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const profile = (id: string, overrides: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: id as ProfileId,
  name: id,
  baseURL: `https://${id}.example/v1`,
  keyRef: "",
  models: [],
  ...overrides,
});

const codexHost = {
  kind: "codex",
  listModels: () => Effect.succeed([]),
} as unknown as AgentHost;

const setup = (
  fetcher: Fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "gpt-5" }] }),
  }),
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const vault = makeMemoryVault();
    const gateway = makeGateway({
      store,
      hosts: AgentHosts.fromHosts([codexHost]),
      vault,
      fetcher,
      home,
    });
    for (const p of yield* store.listProfiles) yield* store.removeProfile(p.id);
    return { store, vault, ...gateway };
  });

const opusHost = (kind: string) =>
  ({
    kind,
    listModels: () =>
      Effect.succeed([{ id: "opus", displayName: "Claude Opus", supportsEffort: true }]),
  }) as unknown as AgentHost;

describe("gateway handlers", () => {
  layer(ThreadStore.layerSqlite(":memory:"))("with an in-memory store", (it) => {
    it.effect("models.list without a profile serves the agent host's own list, as before", () =>
      Effect.gen(function* () {
        const claudeModels = [
          { id: "opus", displayName: "Claude Opus", supportsEffort: true, isDefault: true },
          { id: "haiku", displayName: "Claude Haiku", supportsEffort: false },
        ];
        const claudeHost = {
          kind: "claude",
          listModels: () => Effect.succeed(claudeModels),
        } as unknown as AgentHost;
        const { handlers } = makeGateway({
          store: yield* ThreadStore,
          hosts: AgentHosts.fromHosts([claudeHost]),
          vault: makeMemoryVault(),
          fetcher: async () => Promise.reject(new Error("no network in tests")),
          home,
        });
        expect(yield* handlers["models.list"]({ agent: "claude" })).toEqual({
          models: claudeModels,
        });
        const unavailable = yield* Effect.flip(handlers["models.list"]({ agent: "codex" }));
        expect(unavailable).toBeInstanceOf(AgentUnavailable);
      }),
    );

    it.effect(
      "Grok refuses an explicitly supplied gateway even when its profile and key exist",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const vault = makeMemoryVault();
          const saved = profile("synthetic-grok-gateway", { keyRef: "synthetic-grok-key" });
          yield* store.upsertProfile(saved);
          yield* vault.set("synthetic-grok-key", Redacted.make("synthetic-only-key"));
          const { handlers } = makeGateway({
            store,
            hosts: AgentHosts.fromHosts([makeGrokHost({ home: join(home, "synthetic-grok") })]),
            vault,
            fetcher: async () => {
              throw new Error("No network for Grok profile refusal");
            },
            home,
          });
          const error = yield* Effect.flip(
            handlers["models.list"]({ agent: "grok", profileId: saved.id }),
          );
          expect(error).toBeInstanceOf(AgentUnavailable);
          expect(error.message).toContain("cannot enforce subscription-only inference routing");
        }),
    );

    it.effect("models.list appends the user's own models, direct and through a profile", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { handlers } = makeGateway({
          store,
          hosts: AgentHosts.fromHosts([opusHost("claude"), opusHost("codex")]),
          vault: makeMemoryVault(),
          fetcher: async () => Promise.reject(new Error("no network in tests")),
          home,
        });
        yield* store.updateSettings((settings) => ({
          ...settings,
          agents: {
            ...settings.agents,
            customModels: [
              { agent: "claude", id: "claude-preview" },
              { agent: "codex", id: "lab/next", name: "Next", effort: false },
            ],
          },
        }));
        const added = { description: "Added in Settings" };
        expect((yield* handlers["models.list"]({ agent: "claude" })).models).toEqual([
          { id: "opus", displayName: "Claude Opus", supportsEffort: true },
          { ...added, id: "claude-preview", displayName: "claude-preview", supportsEffort: true },
        ]);

        yield* handlers["profiles.upsert"]({
          profile: profile("a", { models: [{ id: "mini", name: "Mini" }] }),
        });
        const viaProfile = yield* handlers["models.list"]({
          agent: "codex",
          profileId: "a" as ProfileId,
        });
        expect(viaProfile.models.map((m) => m.id)).toEqual(["mini", "lab/next"]);

        // The layer's store outlives this test.
        yield* store.updateSettings((settings) => ({
          ...settings,
          agents: { ...settings.agents, customModels: [] },
        }));
        yield* handlers["profiles.remove"]({ profileId: "a" as ProfileId });
      }),
    );

    it.effect("upserts with a server-owned keyRef and a single default", () =>
      Effect.gen(function* () {
        const { handlers, store } = yield* setup();
        const saved = yield* handlers["profiles.upsert"]({
          profile: profile("a", { keyRef: "evil", default: true }),
        });
        expect(saved.keyRef).toBe("");
        yield* handlers["profiles.upsert"]({ profile: profile("b", { default: true }) });
        const profiles = yield* store.listProfiles;
        expect(profiles.filter((p) => p.default === true).map((p) => p.id)).toEqual(["b"]);
      }),
    );

    it.effect(
      "setKey stores the key in the vault and marks the profile, never the key itself",
      () =>
        Effect.gen(function* () {
          const { handlers, store, vault } = yield* setup();
          yield* handlers["profiles.upsert"]({ profile: profile("a") });
          yield* handlers["profiles.setKey"]({
            profileId: "a" as ProfileId,
            key: Redacted.make(`  ${SECRET}  `),
          });
          const [stored] = yield* store.listProfiles;
          expect(stored?.keyRef).toBe("profile:a");
          expect(JSON.stringify(stored)).not.toContain(SECRET);
          expect(Option.map(yield* vault.get("profile:a"), Redacted.value)).toEqual(
            Option.some(SECRET),
          );

          // An empty key clears it.
          yield* handlers["profiles.setKey"]({
            profileId: "a" as ProfileId,
            key: Redacted.make(""),
          });
          expect((yield* store.listProfiles)[0]?.keyRef).toBe("");
          expect(Option.isNone(yield* vault.get("profile:a"))).toBe(true);

          const missing = yield* Effect.flip(
            handlers["profiles.setKey"]({
              profileId: "nope" as ProfileId,
              key: Redacted.make(SECRET),
            }),
          );
          expect(missing).toBeInstanceOf(NotFound);
        }),
    );

    it.effect(
      "setKey fails with a GatewayError that never quotes the key when the vault refuses it",
      () =>
        Effect.gen(function* () {
          const { handlers, store } = yield* setup();
          yield* handlers["profiles.upsert"]({ profile: profile("a") });
          const refusing = makeGateway({
            store,
            hosts: AgentHosts.fromHosts([codexHost]),
            vault: {
              ...makeMemoryVault(),
              set: (_ref, key) =>
                Effect.fail(new VaultError({ message: `bridge rejected ${Redacted.value(key)}` })),
            },
            fetcher: async () => ({ ok: true, status: 200, json: async () => ({}) }),
            home,
          });

          const error = yield* Effect.flip(
            refusing.handlers["profiles.setKey"]({
              profileId: "a" as ProfileId,
              key: Redacted.make(SECRET),
            }),
          );
          expect(error).toBeInstanceOf(GatewayError);
          expect(error).toMatchObject({ profileId: "a" });
          expect(error.message).not.toContain(SECRET);
          expect((yield* store.listProfiles)[0]?.keyRef).toBe("");
        }),
    );

    it.effect("remove deletes the profile and its key", () =>
      Effect.gen(function* () {
        const { handlers, store, vault } = yield* setup();
        yield* handlers["profiles.upsert"]({ profile: profile("a") });
        yield* handlers["profiles.setKey"]({
          profileId: "a" as ProfileId,
          key: Redacted.make(SECRET),
        });
        yield* handlers["profiles.remove"]({ profileId: "a" as ProfileId });
        expect(yield* store.listProfiles).toEqual([]);
        expect(Option.isNone(yield* vault.get("profile:a"))).toBe(true);
      }),
    );

    it.effect("discoverModels needs a key, then persists the gateway's models", () =>
      Effect.gen(function* () {
        const seen: Array<string | undefined> = [];
        const { handlers, store } = yield* setup(async (_url, init) => {
          seen.push(init.headers["Authorization"]);
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "gpt-5" }, { id: "claude" }] }),
          };
        });
        yield* handlers["profiles.upsert"]({ profile: profile("a") });
        const noKey = yield* Effect.flip(
          handlers["profiles.discoverModels"]({ profileId: "a" as ProfileId }),
        );
        expect(noKey).toBeInstanceOf(GatewayError);
        expect(noKey.message).toContain("Set a key");

        yield* handlers["profiles.setKey"]({
          profileId: "a" as ProfileId,
          key: Redacted.make(SECRET),
        });
        const models = yield* handlers["profiles.discoverModels"]({ profileId: "a" as ProfileId });
        expect(models.map((m) => m.id)).toEqual(["gpt-5", "claude"]);
        // Saving the key discovers once on its own; the explicit call discovers again.
        expect(seen).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
        expect((yield* store.listProfiles)[0]?.models.map((m) => m.id)).toEqual([
          "gpt-5",
          "claude",
        ]);
      }),
    );

    it.effect("resolves an adapter's credentials only for a profile with a stored key", () =>
      Effect.gen(function* () {
        const { handlers, credentials } = yield* setup();
        yield* handlers["profiles.upsert"]({ profile: profile("litellm") });
        const missing = yield* Effect.flip(credentials("litellm" as ProfileId, "codex"));
        expect(missing).toBeInstanceOf(AgentUnavailable);
        expect(missing.message).toBe("Set a key for litellm first.");
        expect((yield* Effect.flip(credentials("nope" as ProfileId, "codex"))).message).toBe(
          "Gateway profile nope doesn't exist.",
        );

        yield* handlers["profiles.setKey"]({
          profileId: "litellm" as ProfileId,
          key: Redacted.make(SECRET),
        });
        const resolved = yield* credentials("litellm" as ProfileId, "codex");
        expect(resolved.profile.id).toBe("litellm");
        expect(Redacted.isRedacted(resolved.key)).toBe(true);
        expect(Redacted.value(resolved.key)).toBe(SECRET);
        expect(JSON.stringify(resolved)).not.toContain(SECRET);
      }),
    );

    it.effect("models.list serves a profile's models once the agent's adapter is registered", () =>
      Effect.gen(function* () {
        const { handlers } = yield* setup();
        yield* handlers["profiles.upsert"]({
          profile: profile("a", {
            models: [
              { id: "gpt-5", name: "GPT-5", variants: ["low", "high"] },
              { id: "mini", name: "Mini" },
            ],
          }),
        });
        const { models } = yield* handlers["models.list"]({
          agent: "codex",
          profileId: "a" as ProfileId,
        });
        expect(models).toEqual([
          {
            id: "gpt-5",
            displayName: "GPT-5",
            supportsEffort: true,
            efforts: ["low", "high"],
            isDefault: true,
          },
          {
            id: "mini",
            displayName: "Mini",
            supportsEffort: true,
            efforts: ["low", "medium", "high", "xhigh"],
            effortsUnlisted: true,
          },
        ]);

        const unregistered = yield* Effect.flip(
          handlers["models.list"]({ agent: "claude", profileId: "a" as ProfileId }),
        );
        expect(unregistered).toBeInstanceOf(AgentUnavailable);
        const unknown = yield* Effect.flip(
          handlers["models.list"]({ agent: "codex", profileId: "zzz" as ProfileId }),
        );
        expect(unknown).toBeInstanceOf(AgentUnavailable);
      }),
    );

    it.effect(
      "imports gateway profiles only on request and preserves selected profile IDs and keys",
      () =>
        Effect.gen(function* () {
          mkdirSync(join(home, ".config", "opencode"), { recursive: true });
          writeFileSync(
            join(home, ".config", "opencode", "opencode.json"),
            JSON.stringify({
              provider: {
                invented: { options: { baseURL: "https://invented.example.invalid/v1" } },
              },
            }),
          );
          const { handlers, store, vault } = yield* setup();
          expect(yield* store.listProfiles).toEqual([]);
          expect(Option.isNone(yield* vault.get("profile:opencode-invented"))).toBe(true);
          expect(yield* handlers["profiles.seed"]()).toEqual({ added: 1 });
          const imported = yield* store.listProfiles;
          expect(imported[0]).toMatchObject({
            id: "opencode-invented",
            baseURL: "https://invented.example.invalid/v1",
            keyRef: "",
          });
          yield* handlers["profiles.setKey"]({
            profileId: "opencode-invented" as ProfileId,
            key: Redacted.make(SECRET),
          });
          const selected = yield* store.listProfiles;
          expect(yield* handlers["profiles.seed"]()).toEqual({ added: 0 });
          expect(yield* store.listProfiles).toEqual(selected);
          expect(Option.map(yield* vault.get("profile:opencode-invented"), Redacted.value)).toEqual(
            Option.some(SECRET),
          );
        }),
    );

    it.effect("imports OpenCode's key for the matching base URL only when asked", () =>
      Effect.gen(function* () {
        mkdirSync(join(home, ".config", "opencode"), { recursive: true });
        mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
        writeFileSync(
          join(home, ".config", "opencode", "opencode.json"),
          JSON.stringify({
            provider: { litellm: { options: { baseURL: "https://a.example/v1" } } },
          }),
        );
        writeFileSync(
          join(home, ".local", "share", "opencode", "auth.json"),
          JSON.stringify({ litellm: { type: "api", key: SECRET } }),
        );

        const { handlers, importOpenCodeKey, store, vault } = yield* setup();
        yield* handlers["profiles.upsert"]({ profile: profile("a") });
        yield* handlers["profiles.upsert"]({ profile: profile("b") });
        expect(Option.isNone(yield* vault.get("profile:a"))).toBe(true);

        expect(yield* importOpenCodeKey("a" as ProfileId)).toEqual({ imported: true });
        expect(Option.map(yield* vault.get("profile:a"), Redacted.value)).toEqual(
          Option.some(SECRET),
        );
        expect(
          yield* handlers["profiles.importKey"]({
            profileId: "b" as ProfileId,
            source: "opencode",
          }),
        ).toEqual({ imported: false });
        expect((yield* store.listProfiles).find((p) => p.id === "b")?.keyRef).toBe("");
      }),
    );
  });
});
