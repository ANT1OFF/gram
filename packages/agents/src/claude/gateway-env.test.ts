import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";

import { buildChildEnv } from "./env.ts";
import {
  anthropicBaseUrl,
  gatewayChildEnv,
  gatewayModelEnv,
  redactKey,
  withoutWebSearch,
} from "./gateway-env.ts";

const KEY = "sk-litellm-test-key";

describe("anthropicBaseUrl", () => {
  it("drops a trailing /v1 and slashes, keeping custom proxy paths", () => {
    expect(anthropicBaseUrl("http://litellm:4000/v1")).toBe("http://litellm:4000");
    expect(anthropicBaseUrl("http://litellm:4000/v1/")).toBe("http://litellm:4000");
    expect(anthropicBaseUrl("https://llm.example/ai/llm/v1/proxy/")).toBe(
      "https://llm.example/ai/llm/v1/proxy",
    );
    expect(anthropicBaseUrl(" https://gw.example ")).toBe("https://gw.example");
  });
});

describe("gatewayChildEnv", () => {
  it("sets the gateway URL and both key variables on top of the stripped env", () => {
    const stripped = buildChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "inherited-key",
      ANTHROPIC_BASE_URL: "https://inherited.example",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-subscription-token",
      Claude_Code_Oauth_Token_File_Descriptor: "5",
    });
    expect(gatewayChildEnv(stripped, "http://litellm:4000/v1", Redacted.make(KEY))).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      CLAUDE_CODE_HARBOR_KITE: "0",
      CLAUDE_CODE_ARTIFACT: "1",
      ANTHROPIC_BASE_URL: "http://litellm:4000",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_API_KEY: KEY,
    });
  });
});

const model = (id: string, info?: { deprecated?: boolean; webSearch?: boolean }) => ({
  id,
  name: id,
  ...(info === undefined ? {} : { info }),
});

describe("gatewayModelEnv", () => {
  // An invented gateway catalog with family aliases and optional suffixed routes.
  const example = [
    model("opus-latest"),
    model("sonnet-latest"),
    model("a-claude-opus-5.5"),
    model("a-claude-opus-4.8"),
    model("a-claude-fable-5"),
    model("a-claude-fable-5.1"),
    model("a-claude-haiku-4.5"),
    model("claude-haiku-4.5", { webSearch: false }),
    model("claude-opus-5.5-eu", { webSearch: false }),
    model("claude-sonnet-4.6-eu", { webSearch: false }),
    model("claude-sonnet-5-eu", { webSearch: false }),
    model("claude-haiku-4.5-eu", { webSearch: false }),
    model("claude-4-sonnet-eu", { deprecated: true }),
  ];

  it("maps Claude Code's aliases to the gateway's aliases, then its newest native route", () => {
    expect(gatewayModelEnv(example, "opus-latest")).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-latest",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-latest",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "a-claude-haiku-4.5",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "a-claude-fable-5.1",
      ANTHROPIC_SMALL_FAST_MODEL: "a-claude-haiku-4.5",
    });
  });

  it("keeps an EU thread on the newest EU route of each family, else on its own model", () => {
    expect(gatewayModelEnv(example, "claude-sonnet-5-eu")).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5.5-eu",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-eu",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4.5-eu",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-sonnet-5-eu",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4.5-eu",
    });
  });

  it("moves haiku to Haiku 5.5 once the gateway serves it, on the native or the EU route", () => {
    const withHaiku55 = [
      ...example,
      model("a-claude-haiku-5.5"),
      model("claude-haiku-5.5", { webSearch: false }),
      model("claude-haiku-5.5-eu", { webSearch: false }),
    ];
    expect(gatewayModelEnv(withHaiku55, "opus-latest")).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "a-claude-haiku-5.5",
      ANTHROPIC_SMALL_FAST_MODEL: "a-claude-haiku-5.5",
    });
    expect(gatewayModelEnv(withHaiku55, "claude-opus-5.5-eu")).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5.5-eu",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-5.5-eu",
    });
  });

  it("falls back to Bedrock names, and to the thread's model where the gateway has none", () => {
    const bedrock = [model("claude-haiku-4.5"), model("claude-opus-5"), model("claude-opus-4.8")];
    expect(gatewayModelEnv(bedrock, "gpt-6-sol")).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-6-sol",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4.5",
    });
    expect(gatewayModelEnv(bedrock, undefined)).toEqual({});
  });

  it("turns WebSearch off only where the gateway declares no hosted search", () => {
    expect(withoutWebSearch(example, "claude-opus-5.5-eu")).toBe(true);
    expect(withoutWebSearch(example, "opus-latest")).toBe(false);
    expect(withoutWebSearch(example, "not-listed")).toBe(false);
  });
});

describe("redactKey", () => {
  it("masks the key and leaves text alone without one", () => {
    expect(redactKey(`401 invalid key ${KEY}`, Redacted.make(KEY))).toBe(
      "401 invalid key [redacted]",
    );
    expect(redactKey("plain", undefined)).toBe("plain");
    expect(redactKey("plain", Redacted.make(""))).toBe("plain");
  });
});
