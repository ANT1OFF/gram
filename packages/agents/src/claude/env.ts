const STRIP_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_HARBOR_KITE",
]);

const STRIP_PREFIXES = [
  "CLAUDE_CODE_USE_",
  "CLAUDE_CODE_SESSION_",
  "CLAUDE_CODE_MESSAGING_",
  "CMUX_",
];

/**
 * Whether a variable would switch auth away from the subscription, leak a parent session or turn
 * cross-session messaging back on.
 */
export const isStrippedEnvVar = (name: string): boolean => {
  const key = name.toUpperCase();
  return STRIP_EXACT.has(key) || STRIP_PREFIXES.some((prefix) => key.startsWith(prefix));
};

const ARTIFACT_OPT_IN = "CLAUDE_CODE_ARTIFACT";

/**
 * Claude Code's switch for cross-session messaging (CLI 2.1.301): `0` leaves the session with no
 * messaging socket, so no other session can list or reach it, takes `ListAgents` away and narrows
 * `SendMessage` to the session's own subagents. Peer messages bypass Gram's routing, approval and
 * `<worker-message>` fence, arriving as a meta user turn the model is told to act on and that
 * Gram's transcript never shows. Off in every child; a session allowed to send to sessions outside
 * Gram drops it (`withPeerMessaging`).
 */
export const PEER_MESSAGING_SWITCH = "CLAUDE_CODE_HARBOR_KITE";

/**
 * Claude Code's own setting for inbound peer messages. `refuse` turns every one away with a
 * delivery notice to the sender, whatever the permission modes, and outranks user and project
 * settings, which may only tighten it. Every Gram session sets it, even one allowed to send.
 */
export const REFUSE_PEER_MESSAGES = { crossSessionInbound: "refuse" } as const;

/**
 * What Gram's `claude` children report as `CLAUDE_CODE_ENTRYPOINT`, in place of the Agent SDK's
 * `sdk-ts`. Claude Code 2.1.316 sends it in its `User-Agent` (`claude-cli/<ver> (external, gram)`)
 * and reads it only from the process env, not from its settings `env`. Gram has no per-profile env
 * of its own, so nothing overrides it; a `claude` run in Gram's terminal keeps its own.
 */
export const GRAM_ENTRYPOINT = "gram";

/**
 * The `claude` child environment: the probed login-shell env minus API-key auth and parent-session
 * leakage, named as Gram's (`GRAM_ENTRYPOINT`), with session-state events and the Artifact tool
 * switched on and cross-session messaging off (`PEER_MESSAGING_SWITCH`). A user's own `CLAUDE_CODE_ARTIFACT` wins, so `0` keeps artifacts
 * off. The SDK's `env` replaces the environment entirely, so this must be complete.
 */
export const buildChildEnv = (
  probed: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(probed)) {
    if (value === undefined || isStrippedEnvVar(name)) continue;
    env[name] = value;
  }
  env["CLAUDE_CODE_ENTRYPOINT"] = GRAM_ENTRYPOINT;
  env["CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"] = "1";
  env[PEER_MESSAGING_SWITCH] = "0";
  if (!Object.keys(env).some((name) => name.toUpperCase() === ARTIFACT_OPT_IN)) {
    env[ARTIFACT_OPT_IN] = "1";
  }
  return env;
};

/**
 * `env` with Claude Code's cross-session messaging back to its default, for a session the user lets
 * send to their other Claude Code sessions. Inbound stays refused (`REFUSE_PEER_MESSAGES`).
 */
export const withPeerMessaging = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== PEER_MESSAGING_SWITCH),
  );

const envWord = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string => {
  const exact = env[name];
  if (exact !== undefined || platform !== "win32") return (exact ?? "").trim();
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return (key === undefined ? "" : (env[key] ?? "")).trim();
};

const ON_WORDS = new Set(["1", "true", "yes", "on"]);
const OFF_WORDS = new Set(["0", "false", "no", "off"]);

const anthropicHost = (url: string): boolean => {
  try {
    return new URL(url).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
};

/**
 * Whether a `claude` child started with `env` defers MCP tool schemas behind tool search rather
 * than loading every one up front, as Claude Code 2.1.293 decides it from its environment.
 * `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` keeps it off whatever else is set. `ENABLE_TOOL_SEARCH`
 * set to `false` (or `auto:100`) turns it off, and any other value on. Unset, it is on unless
 * `ANTHROPIC_BASE_URL` points away from Anthropic's API, as a gateway profile's does, since most
 * proxies don't forward `tool_reference` blocks. Only the env is read: an `env` block in the
 * user's Claude settings, a model older than the 4.5 generation or an Azure Foundry deployment can
 * keep it off too.
 */
export const toolSearchOn = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const read = (name: string) => envWord(env, name, platform);
  if (ON_WORDS.has(read("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS").toLowerCase())) return false;
  const setting = read("ENABLE_TOOL_SEARCH").toLowerCase();
  if (setting !== "") {
    if (OFF_WORDS.has(setting)) return false;
    const threshold = /^auto:(.*)$/.exec(setting)?.[1];
    return threshold === undefined || !(Number.parseFloat(threshold) >= 100);
  }
  const base = read("ANTHROPIC_BASE_URL");
  return base === "" || anthropicHost(base);
};

const TOKEN_CHILD_STRIP_EXACT = new Set([
  "NODE_OPTIONS",
  "NODE_DEBUG",
  "NODE_V8_COVERAGE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_PRESERVE_SYMLINKS",
  "BUN_OPTIONS",
  "BUN_CONFIG_VERBOSE_FETCH",
  "SSLKEYLOGFILE",
  "BASH_ENV",
  "ENV",
  "ANTHROPIC_LOG",
  "DEBUG",
  "ELECTRON_RUN_AS_NODE",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "CLAUDE_DEBUG",
  "CLAUDE_CODE_TEE_SDK_STDOUT",
  "CLAUDE_CODE_TERMINAL_RECORDING",
  "CLAUDE_CODE_SESSION_LOG",
  "CLAUDE_CODE_PERFETTO_TRACE",
  "CLAUDE_CODE_FRAME_TIMING_LOG",
  "CLAUDE_PTY_RECORD",
  "OTEL_LOG_RAW_API_BODIES",
  "VCR_RECORD",
]);
const TOKEN_CHILD_STRIP_PREFIXES = [
  "NODE_INSPECT",
  "BUN_INSPECT",
  "DYLD_",
  "DEBUG_",
  "CLAUDE_CODE_DEBUG",
];

/** Whether a token-bearing child must not inherit `name` (`TOKEN_CHILD_STRIP_EXACT`). */
export const isTokenChildStripped = (name: string): boolean => {
  const key = name.toUpperCase();
  return (
    TOKEN_CHILD_STRIP_EXACT.has(key) ||
    TOKEN_CHILD_STRIP_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
};

/**
 * `env` for a process that will hold a `claude setup-token` token: without the debugger, preload,
 * request-logging and TLS-bypass settings (`isTokenChildStripped`), and without any OAuth token
 * already in it, which the caller sets itself when it means to.
 */
export const tokenChildEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isTokenChildStripped(name)) continue;
    if (name.toUpperCase().startsWith("CLAUDE_CODE_OAUTH_TOKEN")) continue;
    out[name] = value;
  }
  return out;
};

/**
 * The env a Claude child is finally spawned with, after the Agent SDK has added its own settings:
 * when it carries an OAuth token, the token-child policy again (`tokenChildEnv`), so nothing the
 * SDK set (such as `DEBUG`) reaches the process that holds it. The token itself is kept.
 */
export const spawnEnvFor = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  const token = env["CLAUDE_CODE_OAUTH_TOKEN"];
  return token === undefined || token === ""
    ? { ...env }
    : { ...tokenChildEnv(env), CLAUDE_CODE_OAUTH_TOKEN: token };
};
