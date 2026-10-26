// @vitest-environment happy-dom
import type { ProfileId } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi } from "./mock";
import { MOCK_AGENTS_KEY } from "./mock-overrides";
import type { ApiServerEvent } from "./types";

const LITELLM = "litellm" as ProfileId;

async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(() => sessionStorage.clear());

describe("MockApi gateways", () => {
  it("discovers models and makes the profile the default when none is", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    await api.upsertProfile({
      id: "other" as ProfileId,
      name: "Other",
      baseURL: "https://other.example.test/v1",
      keyRef: "",
      models: [],
    });

    // Personal Gateway is the seeded default, so Other stays non-default.
    expect(await api.setProfileKey("other" as ProfileId, "sk-x")).toEqual({ discovered: 3 });
    await api.removeProfile(LITELLM);
    await api.setProfileKey("other" as ProfileId, "");
    const [cleared] = await api.listProfiles();
    expect(cleared?.keyRef).toBe("");

    expect(await api.setProfileKey("other" as ProfileId, "sk-y")).toEqual({
      discovered: 3,
      madeDefault: true,
    });
    const [saved] = await api.listProfiles();
    expect(saved).toMatchObject({ keyRef: "profile:other", default: true });
    expect(saved?.models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5.6-sol", "claude-sonnet"]);
  });

  it("seeds a keyless LiteLLM profile only while there are none", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    expect(await api.seedProfiles()).toEqual({ added: 0 });
    await api.removeProfile(LITELLM);

    expect(await api.seedProfiles()).toEqual({ added: 1 });
    expect(await api.listProfiles()).toEqual([
      {
        id: "litellm",
        name: "LiteLLM",
        baseURL: "https://personal.example.invalid/v1",
        keyRef: "",
        models: [],
      },
    ]);
    expect(await api.seedProfiles()).toEqual({ added: 0 });
  });

  it("keeps keys in the macOS Keychain", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    expect(await api.vaultInfo()).toEqual({
      kind: "keychain",
      persisted: true,
      label: "the macOS Keychain",
    });
  });

  it("publishes profiles.changed after each change", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    await waitFor(() => events.some((e) => e.type === "threads.snapshot"), "snapshot");
    const changes = () => events.filter((e) => e.type === "profiles.changed").length;

    await api.setProfileKey(LITELLM, "sk-x");
    await waitFor(() => changes() === 1, "setKey");
    await api.discoverProfileModels(LITELLM);
    await waitFor(() => changes() === 2, "discovery");
    await api.removeProfile(LITELLM);
    await waitFor(() => changes() === 3, "remove");
    await api.seedProfiles();
    await waitFor(() => changes() === 4, "seed");
    await api.seedProfiles();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes()).toBe(4);
    abort.abort();
  });

  it.each([
    { name: "default assembly", registered: false, custom: false, profileId: undefined },
    { name: "explicit Grok", registered: true, custom: false, profileId: undefined },
    { name: "custom models", registered: true, custom: true, profileId: undefined },
    { name: "default assembly with profile", registered: false, custom: false, profileId: LITELLM },
    {
      name: "registered Grok with custom models and profile",
      registered: true,
      custom: true,
      profileId: LITELLM,
    },
    { name: "missing profile", registered: true, custom: true, profileId: "missing" as ProfileId },
  ])(
    "Grok unavailable through actual mock assembly: $name",
    async ({ registered, custom, profileId }) => {
      const api = createMockApi({
        speed: 0,
        autoplay: false,
        ...(registered ? { agents: ["claude", "codex", "grok"] } : {}),
      });
      if (custom)
        await api.updateSettings({
          agents: { customModels: [{ agent: "grok", id: "synthetic-custom-grok" }] },
        });
      await expect(api.listModels("grok", profileId)).rejects.toMatchObject({
        _tag: "AgentUnavailable",
        agent: "grok",
        message:
          "Grok Build is unavailable in Gram: the official CLI cannot enforce subscription-only inference routing for all configured models and auxiliary requests. Login or a subscription purchase does not resolve this CLI capability limitation. No CLI was started.",
      });
      // Other providers retain the default/explicit assembly's own catalogs.
      expect((await api.listModels("claude")).models[0]?.id).toBe("opus");
      if (registered) expect((await api.listModels("codex")).models[0]?.id).toBe("gpt-5.5");
    },
  );

  it("registers only the agents the session flag names and ignores unknown entries", async () => {
    sessionStorage.setItem(MOCK_AGENTS_KEY, "claude,invented-unknown");
    const api = createMockApi({ speed: 0, autoplay: false });
    await expect(api.listModels("claude")).resolves.toBeTruthy();
    await expect(api.listModels("codex")).rejects.toMatchObject({ _tag: "AgentUnavailable" });
    sessionStorage.setItem(MOCK_AGENTS_KEY, "codex");
    const codexOnly = createMockApi({ speed: 0, autoplay: false });
    await expect(codexOnly.listModels("codex")).resolves.toBeTruthy();
    await expect(codexOnly.listModels("claude")).rejects.toMatchObject({
      _tag: "AgentUnavailable",
    });
  });
});
