import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ReasoningVariant,
  type GatewayModel,
  type GatewayProfile,
  type ProfileId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

const openCodeConfigPath = (home: string) => join(home, ".config", "opencode", "opencode.json");
const openCodeAuthPath = (home: string) => join(home, ".local", "share", "opencode", "auth.json");
const codexConfigPath = (home: string) => join(home, ".codex", "config.toml");

const readText = (path: string): Effect.Effect<string | undefined> =>
  Effect.promise(() => readFile(path, "utf8").catch(() => undefined));

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const isVariant = Schema.is(ReasoningVariant);

/** A base URL as it compares: trimmed, without trailing slashes, case-folded. */
export const normaliseUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

/** OpenCode `provider.*` entries with a `options.baseURL`, as profiles without keys. */
export const profilesFromOpenCode = (config: unknown): Array<GatewayProfile> =>
  Object.entries(record(record(config)?.["provider"]) ?? {}).flatMap(([name, value]) => {
    const provider = record(value);
    const baseURL = string(record(provider?.["options"])?.["baseURL"]);
    if (baseURL === undefined) return [];
    const models = Object.entries(record(provider?.["models"]) ?? {}).map(
      ([id, entry]): GatewayModel => {
        const model = record(entry);
        const context = record(model?.["limit"])?.["context"];
        const variants = Object.keys(record(model?.["variants"]) ?? {}).filter(isVariant);
        return {
          id,
          name: string(model?.["name"]) ?? id,
          ...(Number.isInteger(context) ? { contextWindow: context as number } : {}),
          ...(variants.length > 0 ? { variants } : {}),
        };
      },
    );
    return [
      {
        id: `opencode-${name}` as ProfileId,
        name: string(provider?.["name"]) ?? name,
        baseURL,
        keyRef: "",
        models,
      },
    ];
  });

/** Codex `model_providers.*` entries with a `base_url`; the active provider's `model` seeds its list. */
export const profilesFromCodex = (config: unknown): Array<GatewayProfile> => {
  const root = record(config);
  return Object.entries(record(root?.["model_providers"]) ?? {}).flatMap(([name, value]) => {
    const provider = record(value);
    const baseURL = string(provider?.["base_url"]);
    if (baseURL === undefined) return [];
    const model = root?.["model_provider"] === name ? string(root?.["model"]) : undefined;
    return [
      {
        id: `codex-${name}` as ProfileId,
        name: string(provider?.["name"]) ?? name,
        baseURL,
        keyRef: "",
        models: model === undefined ? [] : [{ id: model, name: model }],
      },
    ];
  });
};

/**
 * Explicitly imported gateway profiles from OpenCode and Codex configs, without keys. A Codex provider on a base URL
 * OpenCode already covers is skipped. The first profile becomes the default.
 */
export const seedProfiles = (home: string): Effect.Effect<Array<GatewayProfile>> =>
  Effect.gen(function* () {
    const openCodeText = yield* readText(openCodeConfigPath(home));
    const codexText = yield* readText(codexConfigPath(home));
    const openCode =
      openCodeText === undefined
        ? []
        : parseOr(() => profilesFromOpenCode(JSON.parse(openCodeText)));
    const codex =
      codexText === undefined ? [] : parseOr(() => profilesFromCodex(parseToml(codexText)));
    const covered = new Set(openCode.map((profile) => normaliseUrl(profile.baseURL)));
    const profiles = [
      ...openCode,
      ...codex.filter((profile) => !covered.has(normaliseUrl(profile.baseURL))),
    ];
    return profiles.map((profile, index) =>
      index === 0 ? { ...profile, default: true } : profile,
    );
  });

const parseOr = (f: () => Array<GatewayProfile>): Array<GatewayProfile> => {
  try {
    return f();
  } catch {
    return [];
  }
};

/**
 * The key OpenCode stored for the provider on `baseURL`, from its `auth.json`. Only called after the
 * user consents in the UI.
 */
export const readOpenCodeKey = (
  home: string,
  baseURL: string,
): Effect.Effect<Option.Option<Redacted.Redacted<string>>> =>
  Effect.gen(function* () {
    const configText = yield* readText(openCodeConfigPath(home));
    const authText = yield* readText(authPathOr(home));
    if (configText === undefined || authText === undefined) return Option.none();
    try {
      const providers = record(record(JSON.parse(configText))?.["provider"]) ?? {};
      const auth = record(JSON.parse(authText)) ?? {};
      const target = normaliseUrl(baseURL);
      for (const [name, value] of Object.entries(providers)) {
        const url = string(record(record(value)?.["options"])?.["baseURL"]);
        if (url === undefined || normaliseUrl(url) !== target) continue;
        const key = string(record(auth[name])?.["key"]);
        if (key !== undefined) return Option.some(Redacted.make(key));
      }
    } catch {
      // Unreadable config: nothing to import.
    }
    return Option.none();
  });

const authPathOr = (home: string) => openCodeAuthPath(home);
