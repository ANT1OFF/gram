import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, layer } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import { GatewayError, OPENROUTER_BASE_URL, type ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { afterAll } from "vitest";

import { ThreadStore } from "../persistence/thread-store.ts";
import { makeGateway } from "../rpc/handlers/gateway.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import type { Fetcher } from "./discovery.ts";
import { makeMemoryVault } from "./key-vault.ts";
import {
  challengeFor,
  exchangeCode,
  listenForCode,
  OPENROUTER_KEYS_URL,
  signInUrl,
  type CodeListener,
  type KeyPoster,
} from "./openrouter-sign-in.ts";

const KEY = "sk-or-v1-test-key";
const home = mkdtempSync(join(tmpdir(), "gram-openrouter-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const PROFILE = "openrouter" as ProfileId;

describe("signing in with OpenRouter", () => {
  it("asks for an S256 challenge that returns to the loopback address", () => {
    // RFC 7636's own example.
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const url = new URL(signInUrl("http://localhost:51423/callback/abc", "challenge"));
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe("http://localhost:51423/callback/abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("takes the code only on its own secret path, then closes", async () => {
    const listener = await listenForCode();
    const base = new URL(listener.callbackUrl);
    expect(base.hostname).toBe("localhost");
    const loopback = `http://127.0.0.1:${base.port}`;
    expect((await fetch(`${loopback}/callback/guess?code=evil`)).status).toBe(404);
    const back = await fetch(`${loopback}${base.pathname}?code=the-code`);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("You can close this tab");
    await expect(listener.code).resolves.toBe("the-code");
  });

  it("gives up when the person doesn't come back", async () => {
    const listener = await listenForCode(20);
    await expect(listener.code).rejects.toThrow("didn't send you back in time");
  });

  it.effect("exchanges the code and verifier for a key, never quoting the answer", () =>
    Effect.gen(function* () {
      const sent: Array<{ url: string; body: unknown }> = [];
      const post: KeyPoster = async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ key: KEY }) };
      };
      const key = yield* exchangeCode(PROFILE, "the-code", "the-verifier", post);
      expect(Redacted.value(key)).toBe(KEY);
      expect(sent).toEqual([
        {
          url: OPENROUTER_KEYS_URL,
          body: { code: "the-code", code_verifier: "the-verifier", code_challenge_method: "S256" },
        },
      ]);
      const refused = yield* Effect.flip(
        exchangeCode(PROFILE, "the-code", "v", async () => ({
          ok: false,
          status: 403,
          json: async () => ({ error: "the-code is bad" }),
        })),
      );
      expect(refused).toBeInstanceOf(GatewayError);
      expect(refused.message).not.toContain("the-code");
    }),
  );
});

const host = (kind: string) =>
  ({ kind, listModels: () => Effect.succeed([]) }) as unknown as AgentHost;

/** OpenRouter's `/models`, for a sample of makers. */
const openRouterModels: Fetcher = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: [
      { id: "anthropic/claude-sonnet-5.5", name: "Sonnet", supported_parameters: ["tools"] },
      { id: "openai/gpt-6.1-sol", name: "Sol", supported_parameters: ["tools", "reasoning"] },
      { id: "moonshotai/kimi-k3", name: "Kimi", supported_parameters: ["tools"] },
      { id: "openai/pictures", name: "Pictures", supported_parameters: [] },
    ],
  }),
});

/** A listener the test hands the code to itself. */
const fakeListener = () => {
  const code = Promise.withResolvers<string>();
  return {
    listen: async (): Promise<CodeListener> => ({
      callbackUrl: "http://localhost:1/callback/secret",
      code: code.promise,
      close: () => undefined,
    }),
    send: code.resolve,
  };
};

describe("the OpenRouter sign-in handlers", () => {
  layer(ThreadStore.layerSqlite(":memory:"))("with an in-memory store", (withStore) => {
    withStore.effect(
      "make an OpenRouter profile with the key, each agent offered its maker's models",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const vault = makeMemoryVault();
          const callback = fakeListener();
          const verifiers: Array<string> = [];
          const { handlers } = makeGateway({
            store,
            hosts: AgentHosts.fromHosts([host("claude"), host("codex")]),
            vault,
            fetcher: openRouterModels,
            home,
            listen: callback.listen,
            post: async (_url, init) => {
              verifiers.push((JSON.parse(init.body) as { code_verifier: string }).code_verifier);
              return { ok: true, status: 200, json: async () => ({ key: KEY }) };
            },
          });
          for (const p of yield* store.listProfiles) yield* store.removeProfile(p.id);
          const started = yield* handlers["profiles.openRouterSignIn"]();
          const challenge = new URL(started.url).searchParams.get("code_challenge");
          callback.send("the-code");
          const result = yield* handlers["profiles.openRouterFinish"]({
            attemptId: started.attemptId,
          });
          expect(challenge).toBe(challengeFor(verifiers[0]!));
          // The first profile is the default as soon as it is made.
          expect(result).toEqual({ profileId: "openrouter", discovered: 4 });
          const [saved] = yield* store.listProfiles;
          expect(saved).toMatchObject({
            id: "openrouter",
            name: "OpenRouter",
            baseURL: OPENROUTER_BASE_URL,
            kind: "openrouter",
            default: true,
          });
          const stored = yield* vault.get(saved!.keyRef);
          expect(Option.map(stored, Redacted.value)).toEqual(Option.some(KEY));
          const offered = (agent: "claude" | "codex") =>
            handlers["models.list"]({ agent, profileId: PROFILE }).pipe(
              Effect.map(({ models }) => models.map((model) => model.id)),
            );
          expect(yield* offered("claude")).toEqual(["anthropic/claude-sonnet-5.5"]);
          expect(yield* offered("codex")).toEqual(["openai/gpt-6.1-sol"]);
          // An attempt is finished once.
          const again = yield* Effect.flip(
            handlers["profiles.openRouterFinish"]({ attemptId: started.attemptId }),
          );
          expect(again.message).toContain("Start again");
        }),
    );
  });
});
