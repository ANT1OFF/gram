/** Supported 0.162.1 controls. No environment is distinct from a complete tool allowlist. */
export const CODEX_HELPER_VERSION = "0.162.1";
/** Qualified built-in ChatGPT auth route in 0.162.1, never the user's custom endpoint. */
export const CODEX_HELPER_SUBSCRIPTION_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_HELPER_FEATURES = Object.fromEntries(
  [
    "plugins",
    "apps",
    "shell_snapshot",
    "shell_tool",
    "stable_environment_tools",
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
