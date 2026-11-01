/**
 * Supported 0.164.0 controls. No environment is distinct from a complete tool allowlist: no key
 * found removes `apply_patch`, which 0.164.0 can still declare on some models and which can't run
 * with `environments: []`. `config/read` echoes a removed feature's key (`js_repl` here), so
 * reading one back proves nothing about the behaviour it once switched.
 */
export const CODEX_HELPER_VERSION = "0.164.0";
/** Built-in ChatGPT auth route for 0.164.0, never the user's custom endpoint. */
export const CODEX_HELPER_SUBSCRIPTION_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_HELPER_FEATURES = Object.fromEntries(
  [
    "plugins",
    "apps",
    "shell_snapshot",
    "shell_tool",
    "js_repl",
    "code_mode",
    "code_mode_only",
    "code_mode_host",
    "multi_agent",
    "multi_agent_v2",
    "memories",
    "hooks",
    "browser_use",
    "computer_use",
    "image_generation",
    "deferred_executor",
    "sleep_tool",
    "token_budget",
    "send_message_to_user_async",
    "view_image",
    "executor_capability_discovery_v2",
    "multi_env_copy_file",
    "request_permissions_tool",
  ].map((name) => [name, false]),
);
export const helperAppServerArgs = (): Array<string> => [
  "app-server",
  "-c",
  'model_provider="openai"',
  "-c",
  `openai_base_url="${CODEX_HELPER_SUBSCRIPTION_BASE_URL}"`,
  "-c",
  'web_search="disabled"',
  "-c",
  "agents.enabled=false",
  ...Object.keys(CODEX_HELPER_FEATURES).flatMap((name) => ["-c", `features.${name}=false`]),
];
