import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayModel, GatewayProfile, ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vitest";

import {
  CATALOG_DIR,
  GATEWAY_CONTEXT_WINDOW,
  catalogBase,
  gatewayCatalog,
  parseCatalog,
  writeCatalog,
  type CatalogEntry,
} from "./catalog.ts";
import { appServerArgs, serverEnv } from "./config.ts";

const profile: GatewayProfile = {
  id: "litellm" as ProfileId,
  name: "LiteLLM",
  baseURL: "https://llm.example/v1",
  keyRef: "profile:litellm",
  models: [],
};

describe("appServerArgs", () => {
  it("runs a gateway app-server without shell snapshots, which would save the key in CODEX_HOME", () => {
    const args = appServerArgs(profile);
    expect(args[0]).toBe("app-server");
    expect(args).toContain("features.shell_snapshot=false");
    expect(args[args.indexOf("features.shell_snapshot=false") - 1]).toBe("-c");
    expect(args).toContain('model_providers.gram.env_key="LLM_API_KEY"');
  });

  it("turns off hosted web search, which the gateway's deployments reject", () => {
    const args = appServerArgs(profile);
    expect(args[args.indexOf('web_search="disabled"') - 1]).toBe("-c");
  });

  it("retries a gateway request at most twice, as integers Codex reads", () => {
    const args = appServerArgs(profile);
    for (const key of ["request_max_retries", "stream_max_retries"]) {
      const at = args.indexOf(`model_providers.gram.${key}=2`);
      expect(args[at - 1]).toBe("-c");
    }
  });

  it("points Codex at a model catalog when there is one", () => {
    const args = appServerArgs(profile, "/data/codex-home/gram-models/example.json");
    expect(args.slice(-2)).toEqual([
      "-c",
      'model_catalog_json="/data/codex-home/gram-models/example.json"',
    ]);
    expect(appServerArgs(profile).join(" ")).not.toContain("model_catalog_json");
  });

  it("pins the owned native home to ChatGPT file auth and keeps exec policy enabled", () => {
    expect(appServerArgs(undefined, undefined, true)).toEqual([
      "app-server",
      "-c",
      'model_provider="openai"',
      "-c",
      'openai_base_url="https://chatgpt.com/backend-api/codex"',
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "features.exec_policy=true",
    ]);
  });

  it("leaves the user's own app-server alone", () => {
    expect(appServerArgs()).toEqual(["app-server"]);
  });
});

describe("serverEnv", () => {
  it("keeps the user's own LLM_API_KEY without a profile, for a provider in their config", () => {
    expect(serverEnv({ PATH: "/bin", LLM_API_KEY: "theirs", UNSET: undefined })).toEqual({
      PATH: "/bin",
      LLM_API_KEY: "theirs",
    });
  });

  it("puts a profile's key in LLM_API_KEY over the user's, whatever its case", () => {
    const key = Redacted.make("sk-gateway");
    expect(serverEnv({ PATH: "/bin", llm_api_key: "theirs" }, { profile, key })).toEqual({
      PATH: "/bin",
      LLM_API_KEY: "sk-gateway",
    });
  });
});

// `codex debug models --bundled` from Codex 0.158.0, with its long strings cut short.
const bundled = parseCatalog(
  readFileSync(
    new URL("../../fixtures/codex-catalog/debug-models-bundled-0.158.json", import.meta.url),
    "utf8",
  ),
)!;
const known = new Set(bundled.models.map((entry) => entry.slug));

const model = (id: string): GatewayModel => ({ id, name: id });
const entry = (catalog: { readonly models: ReadonlyArray<CatalogEntry> }, slug: string) =>
  catalog.models.find((m) => m.slug === slug);
const efforts = (catalogEntry: CatalogEntry | undefined) =>
  ((catalogEntry?.["supported_reasoning_levels"] ?? []) as ReadonlyArray<{ effort: string }>).map(
    (level) => level.effort,
  );

describe("catalogBase", () => {
  it("takes the same tier at the nearest version not above the model's", () => {
    expect(catalogBase("gpt-6.1-sol", known)).toBe("gpt-6-sol");
    expect(catalogBase("gpt-7-luna", known)).toBe("gpt-6-luna");
    expect(catalogBase("gpt-6.2-astra", known)).toBe("gpt-6-astra");
  });

  it("strips the gateway's EU data-zone suffix first", () => {
    expect(catalogBase("gpt-6.1-sol-eu", known)).toBe("gpt-6-sol");
    expect(catalogBase("gpt-6-luna-eu", known)).toBe("gpt-6-luna");
    expect(catalogBase("gpt-5.6-terra-eu", known)).toBe("gpt-5.6-terra");
    expect(catalogBase("gpt-5.5-eu", known)).toBe("gpt-5.5");
  });

  it("follows the gateway's aliases for its latest GPT", () => {
    expect(catalogBase("gpt-latest", known)).toBe("gpt-6-sol");
    expect(catalogBase("gpt-chat-latest", known)).toBe("gpt-6-sol");
  });

  it("finds nothing for an older model, another tier, or another vendor", () => {
    expect(catalogBase("gpt-5.4", known)).toBeUndefined();
    expect(catalogBase("gpt-5-mini", known)).toBeUndefined();
    expect(catalogBase("gpt-5.3-codex", known)).toBeUndefined();
    expect(catalogBase("gpt-4o", known)).toBeUndefined();
    expect(catalogBase("a-claude-opus-5.5", known)).toBeUndefined();
    expect(catalogBase("claude-opus-5.5-eu", known)).toBeUndefined();
    expect(catalogBase("text-embedding-3-large", known)).toBeUndefined();
  });
});

describe("gatewayCatalog", () => {
  const catalog = gatewayCatalog(bundled, [
    model("gpt-6-sol"),
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    model("gpt-6.1-sol-eu"),
    model("gpt-6-luna-eu"),
    model("a-claude-opus-5.5"),
    model("text-embedding-3-large"),
  ])!;

  it("keeps every bundled entry as Codex ships it, since the file replaces the catalog", () => {
    expect(catalog.models.slice(0, bundled.models.length)).toEqual(bundled.models);
  });

  it("clones only the models Codex doesn't know and has a base for", () => {
    expect(catalog.models.slice(bundled.models.length).map((m) => m.slug)).toEqual([
      "gpt-6.1-sol",
      "gpt-6.1-sol-eu",
      "gpt-6-luna-eu",
    ]);
  });

  it("gives a clone its base's request shape, with a 272k window and no ultra", () => {
    const base = entry(bundled, "gpt-6-sol")!;
    const clone = entry(catalog, "gpt-6.1-sol")!;
    expect(clone["display_name"]).toBe("GPT-6.1 Sol");
    expect(clone["context_window"]).toBe(GATEWAY_CONTEXT_WINDOW);
    expect(clone["supports_search_tool"]).toBe(base["supports_search_tool"]);
    expect(efforts(base)).toContain("ultra");
    expect(efforts(clone)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const field of [
      "tool_mode",
      "use_responses_lite",
      "apply_patch_tool_type",
      "shell_type",
    ]) {
      expect(clone[field]).toEqual(base[field]);
    }
    expect(efforts(entry(catalog, "gpt-6-luna-eu"))).toEqual(efforts(entry(bundled, "gpt-6-luna")));
  });

  it.each([true, false])(
    "inherits MCP search support (%s) while separately disabling gateway web search",
    (supportsSearch) => {
      const inherited = gatewayCatalog(
        { models: [{ slug: "gpt-6-sol", supports_search_tool: supportsSearch }] },
        [model("gpt-6.1-sol"), model("gpt-6.1-sol-eu"), model("gpt-latest")],
      )!;
      for (const clone of inherited.models.slice(1)) {
        expect(clone["supports_search_tool"]).toBe(supportsSearch);
      }
      const args = appServerArgs(profile, "/data/codex-home/models.json");
      expect(args[args.indexOf('web_search="disabled"') - 1]).toBe("-c");
    },
  );

  it("is undefined when Codex knows every model, so it keeps its own catalog", () => {
    expect(gatewayCatalog(bundled, [model("gpt-6-sol"), model("a-claude-opus-5.5")])).toBe(
      undefined,
    );
  });
});

describe("parseCatalog", () => {
  it("reads only a list of models with slugs", () => {
    expect(parseCatalog("not json")).toBeUndefined();
    expect(parseCatalog('{"models":[]}')).toBeUndefined();
    expect(parseCatalog('{"models":[{"slug":"a"},{"name":"b"}]}')).toEqual({
      models: [{ slug: "a" }],
    });
  });
});

describe("writeCatalog", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("writes one private file per profile", async () => {
    const home = mkdtempSync(join(tmpdir(), "gram-codex-catalog-"));
    dirs.push(home);
    const file = await Effect.runPromise(
      writeCatalog(home, "a/b" as ProfileId, { models: [{ slug: "x" }] }),
    );
    expect(file).toBe(join(home, CATALOG_DIR, "a%2Fb.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ models: [{ slug: "x" }] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, CATALOG_DIR)).mode & 0o777).toBe(0o700);
  });
});
