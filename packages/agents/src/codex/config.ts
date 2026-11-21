import { GATEWAY_PROVIDER_ID, type GatewayProfile } from "@gram/contracts";
import * as Redacted from "effect/Redacted";
import type { GatewayCredentials } from "../gateway.ts";

const KEY_ENV = "LLM_API_KEY";

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
  ownProvider?: string,
): Array<string> => {
  if (profile === undefined)
    return owned
      ? [
          "app-server",
          ...(ownProvider === undefined
            ? [
                "-c",
                'model_provider="openai"',
                "-c",
                'openai_base_url="https://chatgpt.com/backend-api/codex"',
                "-c",
                'forced_login_method="chatgpt"',
                "-c",
                'cli_auth_credentials_store="file"',
              ]
            : ["-c", `model_provider=${toml(ownProvider)}`]),
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
    "-c",
    "features.shell_snapshot=false",
    "-c",
    'web_search="disabled"',
    "-c",
    `model_provider=${toml(GATEWAY_PROVIDER_ID)}`,
    ...provider("name", profile.name),
    ...provider("base_url", profile.baseURL),
    ...provider("env_key", KEY_ENV),
    ...provider("wire_api", "responses"),
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
    if (credentials !== undefined && name.toUpperCase() === KEY_ENV) continue;
    env[name] = value;
  }
  if (credentials) env[KEY_ENV] = Redacted.value(credentials.key);
  return env;
};
