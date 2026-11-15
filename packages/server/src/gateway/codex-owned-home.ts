import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { OUTWARD_RULES_FILE } from "./codex-home.ts";
import { assertOwnedCodexPath } from "./codex-owned-path.ts";
import { APP_TOOLS_SERVER_NAME } from "@gram/agents";
import { realPathOrOwned } from "@gram/git";
import * as Effect from "effect/Effect";
import { parse, stringify } from "smol-toml";

/** The model provider a machine's own Codex runs on, kept by the gated home (`ownCodexProvider`). */
export interface OwnCodexProvider {
  readonly name: string;
  /** Its table as the gated home writes it: only the keys `PROVIDER_KEYS` allows. */
  readonly table: Readonly<Record<string, unknown>>;
  /** The environment variables it reads its credentials from, by name: `env_key`, `env_http_headers`. */
  readonly env: ReadonlyArray<string>;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An environment variable's name, never its value. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const isAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !/[\s]/.test(value);

/**
 * What a kept provider's table may say, each checked for holding no credential. A credential is
 * only ever referenced: by the name of the variable it is in, or by a command (an absolute path)
 * that reads it from files named by absolute paths. A key not listed here, an inline token
 * (`experimental_bearer_token`), literal headers (`http_headers`) or query parameters
 * (`query_params`) keep the provider from being kept at all.
 */
const PROVIDER_KEYS: Readonly<Record<string, (value: unknown) => boolean>> = {
  name: (value) => typeof value === "string",
  base_url: (value) => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  },
  wire_api: (value) => typeof value === "string",
  requires_openai_auth: (value) => value === false,
  env_key: (value) => typeof value === "string" && ENV_NAME.test(value),
  env_key_instructions: (value) => typeof value === "string",
  env_http_headers: (value) =>
    isTable(value) &&
    Object.values(value).every((name) => typeof name === "string" && ENV_NAME.test(name)),
  request_max_retries: (value) => typeof value === "number",
  stream_max_retries: (value) => typeof value === "number",
  stream_idle_timeout_ms: (value) => typeof value === "number",
  supports_websockets: (value) => typeof value === "boolean",
  auth: (value) => {
    if (!isTable(value) || !isAbsolutePath(value["command"])) return false;
    const args = value["args"] ?? [];
    if (!Array.isArray(args) || !args.every(isAbsolutePath)) return false;
    return Object.entries(value).every(
      ([key, each]) =>
        key === "command" ||
        key === "args" ||
        ((key === "timeout_ms" || key === "refresh_interval_ms") && typeof each === "number"),
    );
  },
};

/**
 * The provider a user's Codex configuration runs on in place of a ChatGPT login: `model_provider`
 * names a provider the same file defines in `[model_providers]`, other than `openai`, that says
 * `requires_openai_auth = false` itself. That is how an embedder routes a machine's Codex through
 * its own gateway (a `CODEX_HOME` naming its provider). Anything else is undefined: a ChatGPT
 * login, a built-in provider, one that leaves OpenAI auth unsaid, and one whose table could carry
 * a credential itself (`PROVIDER_KEYS`), which the gated home never copies.
 */
export const ownCodexProvider = (
  user: Readonly<Record<string, unknown>>,
): OwnCodexProvider | undefined => {
  const name = user["model_provider"];
  if (typeof name !== "string" || name === "" || name === "openai") return undefined;
  const providers = user["model_providers"];
  if (!isTable(providers)) return undefined;
  const table = providers[name];
  if (!isTable(table) || table["requires_openai_auth"] !== false) return undefined;
  for (const [key, value] of Object.entries(table)) {
    const allowed = PROVIDER_KEYS[key];
    if (allowed === undefined || !allowed(value)) return undefined;
  }
  const headers = table["env_http_headers"];
  const env = [
    ...(typeof table["env_key"] === "string" ? [table["env_key"]] : []),
    ...(isTable(headers) ? Object.values(headers).filter((each) => typeof each === "string") : []),
  ];
  return { name, table, env: [...new Set(env)] };
};

const userHomeOf = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  resolve(env["CODEX_HOME"] ?? join(home, ".codex"));

const readUserConfig = (source: string): Promise<Record<string, unknown>> =>
  readFile(join(source, "config.toml"), "utf8").then(
    (text) => parse(text),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return {};
    },
  );

/** Whether the user's home holds a login file. Only whether it exists: it is never read. */
const hasLogin = (source: string): Promise<boolean> =>
  stat(join(source, "auth.json")).then(
    (found) => found.isFile(),
    () => false,
  );

/**
 * The provider the gated home keeps for a machine whose Codex runs on its own provider and has no
 * ChatGPT login (`ownCodexProvider`, and no `auth.json` in its home): its name, or undefined, in
 * which case the gated home is the ChatGPT one. A machine with a login keeps the ChatGPT home
 * exactly as before, whatever its configuration names. Never fails: a configuration that can't be
 * read is no provider of its own.
 */
export const ownedCodexProvider = (
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<{ readonly name: string; readonly env: ReadonlyArray<string> } | undefined> =>
  Effect.promise(async () => {
    try {
      const source = userHomeOf(home, env);
      if (await hasLogin(source)) return undefined;
      const own = ownCodexProvider(await readUserConfig(source));
      return own === undefined ? undefined : { name: own.name, env: own.env };
    } catch {
      return undefined;
    }
  });

/**
 * Removes the login link the gated home had while the machine had a ChatGPT login: only Gram's
 * own symlink to the user's `auth.json` path, identified by where it points, never by reading
 * what it points to. Anything else at that path (a regular file, or a link elsewhere) refuses the
 * preparation and is left as it is.
 */
const removeLoginLink = async (link: string, auth: string): Promise<void> => {
  const found = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (found === undefined) return;
  if (!found.isSymbolicLink() || (await readlink(link)) !== auth)
    throw new Error("Unexpected login file in the gated home");
  await rm(link);
};

/**
 * The native gated home shares only the login file, by path. Never read or copy auth: Codex owns
 * its contents and refresh. Keep an allowlist of configuration rather than inheriting profiles,
 * providers, hooks, plugins, rules, project trust or permission overrides. Future CLI options
 * therefore cannot silently opt this home out of its exec-policy backstop.
 *
 * A machine whose Codex runs on its own provider with no ChatGPT login (`ownedCodexProvider`)
 * gets the same home with that one provider kept in place of ChatGPT's, and no login file: no
 * `auth.json` is linked or copied, and one linked before is removed. Its exec-policy backstop and
 * everything else above are the same.
 */
export const prepareOwnedCodexHome = (
  dataDir: string,
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  requireAuth = true,
): Effect.Effect<string> =>
  Effect.promise(async () => {
    try {
      const source = userHomeOf(home, env);
      const target = resolve(dataDir, "codex-owned-home");
      if (source === target || (await realPathOrOwned(source)) === (await realPathOrOwned(target)))
        throw new Error("Native and owned homes coincide");
      const auth = join(source, "auth.json");
      const user = await readUserConfig(source);
      // Only without a login: a ChatGPT install keeps its ChatGPT home whatever it configures.
      const own = (await hasLogin(source)) ? undefined : ownCodexProvider(user);
      if (own === undefined && requireAuth && !(await stat(auth)).isFile())
        throw new Error("Native login file missing");
      await assertOwnedCodexPath(target, true);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
      await assertOwnedCodexPath(join(target, "config.toml"));
      await assertOwnedCodexPath(join(target, "rules"), true);
      await rm(join(target, "rules", OUTWARD_RULES_FILE), { force: true });
      const link = join(target, "auth.json");
      if (own !== undefined) {
        // Its own provider authenticates itself: no login file is linked, and Gram's own link
        // from before goes. Nothing else there is removed.
        await removeLoginLink(link, auth);
      } else if ((await readlink(link).catch(() => undefined)) !== auth) {
        // A CLI may replace its credential file on refresh. Restore the link before every open.
        await rm(link, { force: true });
        await symlink(auth, link, "file");
      }
      const config: Record<string, unknown> = {};
      for (const key of [
        "model",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "model_verbosity",
        "personality",
        "skills",
      ]) {
        if (user[key] !== undefined) config[key] = user[key];
      }
      const servers = user["mcp_servers"];
      if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
        const { [APP_TOOLS_SERVER_NAME]: _ours, ...rest } = servers as Record<string, unknown>;
        config["mcp_servers"] = rest;
      }
      Object.assign(config, {
        ...(own === undefined
          ? {
              model_provider: "openai",
              openai_base_url: "https://chatgpt.com/backend-api/codex",
              forced_login_method: "chatgpt",
              cli_auth_credentials_store: "file",
            }
          : // That one provider, as the user's configuration defines it, and no other.
            { model_provider: own.name, model_providers: { [own.name]: own.table } }),
        // Approval policy and sandbox belong to thread/start and thread/resume. Codex 0.162.1
        // rejects `untrusted` in config.toml even though it accepts the per-thread RPC policy.
        features: {
          exec_policy: true,
          shell_snapshot: false,
          hooks: false,
          plugins: false,
          apps: false,
        },
      });
      const file = join(target, "config.toml");
      await writeFile(file, stringify(config), { mode: 0o600 });
      await chmod(file, 0o600);
      return target;
    } catch {
      // TOML/parser errors may contain config values. Surface setup advice, never the input.
      throw new Error(
        "Gram could not prepare its native Codex home. Check codex login, auth.json and the Gram data directory.",
      );
    }
  });
