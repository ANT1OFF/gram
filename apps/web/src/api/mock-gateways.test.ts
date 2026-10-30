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
