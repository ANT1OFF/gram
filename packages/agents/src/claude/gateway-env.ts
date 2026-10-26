import type { GatewayModel } from "@gram/contracts";
import * as Redacted from "effect/Redacted";

/**
 * `ANTHROPIC_BASE_URL` for a LiteLLM profile. Claude Code appends `/v1/messages`, which LiteLLM
 * serves at its root, so a profile URL ending in `/v1` (the form OpenAI clients use) drops it.
 */
export const anthropicBaseUrl = (baseURL: string): string =>
  baseURL.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

/** Claude Code's model aliases, each with the variable that names its model. */
const FAMILIES = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
} as const;

/** A Claude model family, as Claude Code's aliases name it. */
export type Family = keyof typeof FAMILIES;

const versionOf = (text: string): ReadonlyArray<number> => text.split(".").map(Number);

const newer = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};

/**
 * The gateway model `family` should run on: the catalog's `<family>-latest` alias, else its newest
 * `a-claude-<family>-<version>` route, then `claude-<family>-<version>`. A thread on a `-eu` route
 * keeps its family aliases on that suffix convention. Names alone establish no privacy,
 * location, entitlement or hosted-tool guarantee; those belong to the configured provider.
 */
export const familyModel = (
  models: ReadonlyArray<GatewayModel>,
  family: Family,
  eu: boolean,
): string | undefined => {
  const ids = models
    .filter((model) => model.info?.deprecated !== true && model.info?.restricted !== true)
    .map((model) => model.id);
  if (!eu && ids.includes(`${family}-latest`)) return `${family}-latest`;
  const pattern = eu
    ? new RegExp(`^claude-${family}-(\\d+(?:\\.\\d+)*)-eu$`)
    : new RegExp(`^(?:a-)?claude-${family}-(\\d+(?:\\.\\d+)*)$`);
  let best:
    | { readonly id: string; readonly version: ReadonlyArray<number>; readonly native: boolean }
    | undefined;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match === null) continue;
    const candidate = { id, version: versionOf(match[1]!), native: id.startsWith("a-") };
    if (
      best === undefined ||
      (candidate.native && !best.native) ||
      (candidate.native === best.native && newer(candidate.version, best.version))
    ) {
      best = candidate;
    }
  }
  return best?.id;
};

/** Whether a gateway model uses the optional `-eu` routing suffix; no location is verified. */
export const inEuZone = (model: string | undefined): boolean =>
  model?.trim().endsWith("-eu") === true;

/**
 * Claude Code's built-in model ids for its `opus`, `sonnet`, `haiku` and `fable` aliases, and for
 * its small fast model, mapped to names the gateway serves: subagents such as Explore (haiku) and
 * background jobs ask for those ids, which a LiteLLM gateway doesn't know. A family the gateway has
 * no route for runs on the thread's own model, as does every family of a thread on an EU route
 * with no EU route for it. Nothing for a thread without a model.
 */
export const gatewayModelEnv = (
  models: ReadonlyArray<GatewayModel>,
  threadModel: string | undefined,
): Record<string, string> => {
  const own = threadModel?.trim();
  if (own === undefined || own === "") return {};
  const eu = inEuZone(own);
  const env: Record<string, string> = {};
  for (const [family, name] of Object.entries(FAMILIES) as Array<[Family, string]>) {
    env[name] = familyModel(models, family, eu) ?? own;
  }
  env["ANTHROPIC_SMALL_FAST_MODEL"] = env[FAMILIES.haiku]!;
  return env;
};

/**
 * Whether Claude Code's WebSearch has to be off for `model` on this gateway: it runs on the
 * provider's hosted search, which Bedrock doesn't have, so the gateway passes the tool on and the
 * request fails. Only where the gateway's catalog declares no web search.
 */
export const withoutWebSearch = (
  models: ReadonlyArray<GatewayModel>,
  model: string | undefined,
): boolean => models.find((m) => m.id === model)?.info?.webSearch === false;

/**
 * The child env for a thread on a gateway profile: the stripped subscription env, plus the gateway's
 * URL, the user's key and `gatewayModelEnv`. This env is the only place the key goes.
 */
export const gatewayChildEnv = (
  stripped: Readonly<Record<string, string>>,
  baseURL: string,
  key: Redacted.Redacted<string>,
  models: Record<string, string> = {},
): Record<string, string> => ({
  // Subscription OAuth belongs to the local Claude workflow. A gateway child must receive only
  // its separately selected key, including when a login shell exports a subscription token.
  ...Object.fromEntries(
    Object.entries(stripped).filter(
      ([name]) => !name.toUpperCase().startsWith("CLAUDE_CODE_OAUTH_"),
    ),
  ),
  ...models,
  ANTHROPIC_BASE_URL: anthropicBaseUrl(baseURL),
  // Claude Code sends the token as `Authorization: Bearer` and the API key as `x-api-key`.
  ANTHROPIC_AUTH_TOKEN: Redacted.value(key),
  ANTHROPIC_API_KEY: Redacted.value(key),
});

/** Masks the key wherever it appears, for text that may reach logs or error messages. */
export const redactKey = (text: string, key: Redacted.Redacted<string> | undefined): string => {
  const value = key === undefined ? "" : Redacted.value(key);
  return value === "" ? text : text.replaceAll(value, "[redacted]");
};
