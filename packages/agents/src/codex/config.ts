import { GATEWAY_PROVIDER_ID, type GatewayProfile } from "@gram/contracts";
import * as Redacted from "effect/Redacted";
import type { GatewayCredentials } from "../gateway.ts";

/** The env var the injected provider reads its key from. */
const KEY_ENV = "LLM_API_KEY";

/** A TOML basic string; JSON's escaping is valid TOML. */
const toml = (value: string): string => JSON.stringify(value);

/**
 * `codex app-server` arguments. A gateway profile replaces the model provider with `-c` overrides
 * that name the key's env var; the key itself only ever goes in the child env. Without a profile
 * Codex runs on the user's own configuration and login. `catalog` is the path of a model catalog
 * that replaces Codex's own (see `gatewayCatalog`), and applies only with a profile.
 */
export const appServerArgs = (
  profile?: GatewayProfile,
  catalog?: string,
  owned = false,
): Array<string> => {
  if (profile === undefined)
    return owned
      ? [
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
        ]
      : ["app-server"];
  const provider = (key: string, value: string) => [
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.${key}=${toml(value)}`,
  ];
  return [
    "app-server",
    // Codex's shell snapshots save the app-server's env, the gateway key included, under CODEX_HOME.
    "-c",
    "features.shell_snapshot=false",
    // Gateway sessions only: Azure deployments behind a gateway reject hosted `web_search`.
    // Local subscription sessions return above, preserving the CLI/user's search configuration.
    // LiteLLM reports that as a 429 "No deployments available". Codex adds the tool for a model it doesn't know
    // (gpt-6.1-sol on 0.158), so it is turned off outright rather than left to model metadata.
    "-c",
    'web_search="disabled"',
    "-c",
    `model_provider=${toml(GATEWAY_PROVIDER_ID)}`,
    ...provider("name", profile.name),
    ...provider("base_url", profile.baseURL),
    ...provider("env_key", KEY_ENV),
    ...provider("wire_api", "responses"),
    // The gateway never retries on its own, and much of what it refuses repeats identically (a
    // disabled key's 403, an unknown model's 404). Codex's default budgets only delay that error,
    // and LiteLLM counts each 401, 404 and 5xx against the deployment: a handful in a minute cools
    // the whole model group down for everyone. It sends a 429 once whatever the budget.
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.request_max_retries=2`,
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.stream_max_retries=2`,
    ...(catalog === undefined ? [] : ["-c", `model_catalog_json=${toml(catalog)}`]),
  ];
};

/**
 * The app-server child env: the app's env, with a gateway profile's key in `LLM_API_KEY`. Without
 * a profile the user's own `LLM_API_KEY` stays, since a provider in their `config.toml` may read it.
 */
export const serverEnv = (
  base: Readonly<Record<string, string | undefined>>,
  credentials?: GatewayCredentials,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    // Windows names are case-insensitive, so a differently cased copy would shadow the gateway key.
    if (credentials !== undefined && name.toUpperCase() === KEY_ENV) continue;
    env[name] = value;
  }
  if (credentials) env[KEY_ENV] = Redacted.value(credentials.key);
  return env;
};
