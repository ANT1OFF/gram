import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, layer } from "@effect/vitest";
import {
  GATEWAY_UNLISTED_WARNING,
  withCustomModels,
  type AgentModel,
  type GatewayProfile,
  type ProfileId,
  type ServerEvent,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterAll } from "vitest";

import type { Fetcher } from "../../gateway/discovery.ts";
import { makeMemoryVault } from "../../gateway/key-vault.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import { makeGateway, profileModels, vaultInfo, warnUnknown } from "./gateway.ts";

const home = mkdtempSync(join(tmpdir(), "gram-gateway-keys-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const profile = (id: string, overrides: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: id as ProfileId,
  name: id,
  baseURL: `https://${id}.example/v1`,
  keyRef: "",
  models: [],
  ...overrides,
});

const models: Fetcher = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }),
});

const setup = (fetcher: Fetcher = models) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    for (const p of yield* store.listProfiles) yield* store.removeProfile(p.id);
    const events: Array<ServerEvent> = [];
    const retired: Array<ProfileId> = [];
    const gateway = makeGateway({
      store,
      hosts: AgentHosts.fromHosts([]),
      vault: makeMemoryVault(),
      fetcher,
      home,
      publish: (event) => Effect.sync(() => void events.push(event)),
      onKeyChanged: (profileId) => Effect.sync(() => void retired.push(profileId)),
    });
    return { store, events, retired, ...gateway };
  });

describe("saving a gateway key", () => {
  layer(ThreadStore.layerSqlite(":memory:"))("with an in-memory store", (withStore) => {
    withStore.effect(
      "discovers models, makes a lone profile the default, applies the key and tells clients",
      () =>
        Effect.gen(function* () {
          const { store, events, retired, handlers } = yield* setup();
          // The first profile is the default as soon as it's added.
          expect(yield* handlers["profiles.upsert"]({ profile: profile("litellm") })).toMatchObject(
            { default: true },
          );
          const litellm = "litellm" as ProfileId;

          expect(
            yield* handlers["profiles.setKey"]({
              profileId: litellm,
              key: Redacted.make("  sk-test  "),
            }),
          ).toEqual({ discovered: 2 });
          expect((yield* store.listProfiles)[0]).toMatchObject({
            default: true,
            keyRef: "profile:litellm",
            models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
          });
          expect(retired).toEqual([litellm]);
          expect(events.at(-1)).toEqual({ type: "profiles.changed" });

          // Clearing applies to live sessions too, without discovery.
          expect(
            yield* handlers["profiles.setKey"]({ profileId: litellm, key: Redacted.make("") }),
          ).toEqual({});
          expect(retired).toEqual([litellm, litellm]);
          expect((yield* store.listProfiles)[0]?.keyRef).toBe("");
        }),
    );

    withStore.effect("retires the profile's servers when discovery changes its models", () =>
      Effect.gen(function* () {
        let listed = [{ id: "gpt-5" }];
        const { retired, handlers } = yield* setup(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: listed }),
        }));
        const litellm = "litellm" as ProfileId;
        yield* handlers["profiles.upsert"]({ profile: profile("litellm") });
        yield* handlers["profiles.setKey"]({ profileId: litellm, key: Redacted.make("sk-test") });
        expect(retired).toEqual([litellm]);

        yield* handlers["profiles.discoverModels"]({ profileId: litellm });
        expect(retired).toEqual([litellm]);

        listed = [{ id: "gpt-5" }, { id: "gpt-6.1-sol" }];
        yield* handlers["profiles.discoverModels"]({ profileId: litellm });
        expect(retired).toEqual([litellm, litellm]);
      }),
    );

    withStore.effect(
      "keeps the key when discovery fails, and leaves an existing default alone",
      () =>
        Effect.gen(function* () {
          const { store, handlers } = yield* setup(async () => ({
            ok: false,
            status: 401,
            json: async () => ({}),
          }));
          yield* handlers["profiles.upsert"]({ profile: profile("office", { default: true }) });
          yield* handlers["profiles.upsert"]({ profile: profile("litellm") });

          expect(
            yield* handlers["profiles.setKey"]({
              profileId: "litellm" as ProfileId,
              key: Redacted.make("sk-test"),
            }),
          ).toEqual({ discoveryError: "litellm.example rejected the key (401)" });
          const byId = new Map((yield* store.listProfiles).map((p) => [p.id as string, p]));
          expect(byId.get("litellm")).toMatchObject({ keyRef: "profile:litellm" });
          expect(byId.get("litellm")?.default).toBeUndefined();
          expect(byId.get("office")?.default).toBe(true);
        }),
    );

    withStore.effect("seeds only while no profile exists, and reports where keys are stored", () =>
      Effect.gen(function* () {
        const { handlers } = yield* setup();
        expect(yield* handlers["profiles.seed"]()).toEqual({ added: 0 });
        yield* handlers["profiles.upsert"]({ profile: profile("litellm") });
        expect(yield* handlers["profiles.seed"]()).toEqual({ added: 0 });
        expect(yield* handlers["profiles.vaultInfo"]()).toMatchObject({
          kind: "memory",
          persisted: false,
        });
      }),
    );

    withStore.effect("rejects line breaks and other control characters in a name or base URL", () =>
      Effect.gen(function* () {
        const { store, events, handlers } = yield* setup();
        for (const bad of [
          profile("litellm", { name: "Team\nGateway" }),
          profile("litellm", { name: "Team\u0000" }),
          profile("litellm", { baseURL: "https://litellm.example/v1\r\n" }),
          profile("litellm", { baseURL: "https://litellm.example/\u007fv1" }),
        ]) {
          const error = yield* Effect.flip(handlers["profiles.upsert"]({ profile: bad }));
          expect(error).toMatchObject({ _tag: "GatewayError" });
          expect(error.message).toMatch(/can't contain line breaks or other control characters/);
        }
        expect(yield* store.listProfiles).toEqual([]);
        expect(events).toEqual([]);
        // Tabs are control characters too; ordinary punctuation and non-ASCII names are fine.
        yield* Effect.flip(
          handlers["profiles.upsert"]({ profile: profile("a", { name: "a\tb" }) }),
        );
        expect(
          yield* handlers["profiles.upsert"]({
            profile: profile("example", { name: "EXAMPLE — LiteLLM (ø)" }),
          }),
        ).toMatchObject({ name: "EXAMPLE — LiteLLM (ø)" });
      }),
    );
  });
});

describe("vaultInfo", () => {
  it("names what protects keys per platform, and says a memory vault isn't kept", () => {
    expect(vaultInfo("safeStorage", "darwin")).toEqual({
      kind: "keychain",
      persisted: true,
      label: "the macOS Keychain",
    });
    expect(vaultInfo("safeStorage", "win32")).toMatchObject({
      kind: "dpapi",
      label: "a file encrypted with Windows data protection for your account",
    });
    expect(vaultInfo("safeStorage", "linux", "gnome_libsecret")).toMatchObject({
      kind: "libsecret",
      label: "the system keyring",
    });
    expect(vaultInfo("safeStorage", "linux", "basic_text")).toEqual({
      kind: "unencrypted",
      persisted: true,
      label: "an unencrypted file, as no system keyring is available",
    });
    expect(vaultInfo("memory", "darwin")).toEqual({
      kind: "memory",
      persisted: false,
      label: "not saved; the key is kept only while the server runs",
    });
  });
});

/** The ids a model list marks as the default. */
const defaults = (listed: ReturnType<typeof profileModels>) =>
  listed.filter((model) => model.isDefault === true).map((model) => model.id);

describe("profileModels", () => {
  const discovered = [
    { id: "gpt-5-nano", name: "gpt-5-nano" },
    { id: "gpt-6-astra", name: "GPT-6 Astra", variants: ["low", "high"] as const },
  ];

  it("defaults to the first listed model without a preference", () => {
    expect(defaults(profileModels(discovered, "codex"))).toEqual(["gpt-5-nano"]);
  });

  it("defaults to Codex's own configured model, adding it when discovery didn't list it", () => {
    expect(defaults(profileModels(discovered, "codex", "gpt-6-astra"))).toEqual(["gpt-6-astra"]);
    expect(profileModels(discovered, "codex", "gpt-6-astra").map((m) => m.id)).toEqual([
      "gpt-5-nano",
      "gpt-6-astra",
    ]);
    const unlisted = profileModels(discovered, "codex", "gpt-6-private");
    expect(unlisted.map((m) => m.id)).toEqual(["gpt-6-private", "gpt-5-nano", "gpt-6-astra"]);
    expect(defaults(unlisted)).toEqual(["gpt-6-private"]);
  });

  it("keeps a model the user added in Settings, with the gateway's efforts for it", () => {
    const gpt41 = { id: "gpt-4.1", name: "gpt-4.1", info: { deprecated: true, reasoning: false } };
    const listed = profileModels([gpt41, ...discovered], "claude", undefined, new Set(["gpt-4.1"]));
    expect(listed.find((m) => m.id === "gpt-4.1")).toEqual({
      id: "gpt-4.1",
      displayName: "gpt-4.1",
      supportsEffort: false,
      isDefault: true,
    });
  });

  it("leaves out what no agent can run, unless it's Codex's own configured model", () => {
    const withUnusable = [
      { id: "text-embedding-3-large", name: "embeddings" },
      { id: "gpt-4.1", name: "gpt-4.1", info: { deprecated: true } },
      ...discovered,
    ];
    expect(profileModels(withUnusable, "claude").map((m) => m.id)).toEqual([
      "gpt-5-nano",
      "gpt-6-astra",
    ]);
    expect(defaults(profileModels(withUnusable, "claude"))).toEqual(["gpt-5-nano"]);
    expect(profileModels(withUnusable, "codex", "gpt-4.1").map((m) => m.id)).toEqual([
      "gpt-4.1",
      "gpt-5-nano",
      "gpt-6-astra",
    ]);
  });
});

const warnings = (list: ReadonlyArray<AgentModel>) => list.map((m) => [m.id, m.warning]);

describe("warnUnknown", () => {
  const example = {
    id: "example" as ProfileId,
    models: [
      { id: "gpt-6.1-sol", name: "gpt-6.1-sol" },
      { id: "a-claude-opus-5.5", name: "a-claude-opus-5.5" },
    ],
  };
  // The picker's list: the gateway's models, then one added in Settings the gateway doesn't list.
  const listed = withCustomModels(profileModels(example.models, "codex"), [
    { agent: "codex", id: "gpt-7-preview" },
  ]);

  it.effect("warns about what the gateway doesn't list, then what the agent doesn't know", () =>
    Effect.gen(function* () {
      const codex = {
        kind: "codex" as const,
        knownModels: () => Effect.succeed(new Set(["gpt-6.1-sol", "gpt-7-preview"])),
      };
      expect(warnings(yield* warnUnknown(codex, example, listed))).toEqual([
        ["gpt-6.1-sol", undefined],
        ["a-claude-opus-5.5", "Codex doesn't know this model; it runs on generic settings"],
        ["gpt-7-preview", GATEWAY_UNLISTED_WARNING],
      ]);
    }),
  );

  it.effect(
    "still says what the gateway doesn't list when the agent can't say, or runs any id",
    () =>
      Effect.gen(function* () {
        const silent = { kind: "codex" as const, knownModels: () => Effect.succeed(undefined) };
        const expected = [
          ["gpt-6.1-sol", undefined],
          ["a-claude-opus-5.5", undefined],
          ["gpt-7-preview", GATEWAY_UNLISTED_WARNING],
        ];
        expect(warnings(yield* warnUnknown(silent, example, listed))).toEqual(expected);
        expect(warnings(yield* warnUnknown({ kind: "claude" }, example, listed))).toEqual(expected);
      }),
  );
});
