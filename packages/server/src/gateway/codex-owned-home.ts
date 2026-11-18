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
  /** Its table as the gated home writes it, built afresh from `PROVIDER_SCHEMA` alone. */
  readonly table: Readonly<Record<string, unknown>>;
  /** The environment variables it reads its credentials from, by name: `env_key`, `env_http_headers`. */
  readonly env: ReadonlyArray<string>;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value of `object`'s own property `key`; nothing inherited is ever read. */
const own = (object: unknown, key: string): unknown =>
  isTable(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** An environment variable's name: the only way a kept provider may name a credential. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Each key a kept provider's table may have, and the value the gated home writes for it, or
 * `invalid` for one it won't (the provider is then not kept). Only these keys are ever read, as own
 * properties, and the written table holds only what they return: everything else in the user's
 * table, an inline token, literal headers or query parameters, an auth command and any key a later
 * Codex adds, is never read and never written. A credential can only be named by the variable it
 * is in.
 */
const invalid = Symbol("invalid");
const PROVIDER_SCHEMA = new Map<string, (value: unknown) => unknown>([
  ["name", (value) => (typeof value === "string" && value.length <= 200 ? value : invalid)],
  [
    "base_url",
    (value) => {
      if (typeof value !== "string") return invalid;
      try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === ""
          ? value
          : invalid;
      } catch {
        return invalid;
      }
    },
  ],
  ["wire_api", (value) => (value === "responses" || value === "chat" ? value : invalid)],
  ["requires_openai_auth", (value) => (value === false ? false : invalid)],
  ["env_key", (value) => (typeof value === "string" && ENV_NAME.test(value) ? value : invalid)],
  [
    "env_http_headers",
    (value) => {
      if (!isTable(value)) return invalid;
      const headers: Record<string, string> = {};
      for (const header of Object.keys(value)) {
        const name = value[header];
        if (!HEADER_NAME.test(header) || typeof name !== "string" || !ENV_NAME.test(name))
          return invalid;
        headers[header] = name;
      }
      return headers;
    },
  ],
  ["request_max_retries", (value) => (isCount(value) ? value : invalid)],
  ["stream_max_retries", (value) => (isCount(value) ? value : invalid)],
  ["stream_idle_timeout_ms", (value) => (isCount(value) ? value : invalid)],
  ["supports_websockets", (value) => (typeof value === "boolean" ? value : invalid)],
]);

/**
 * The provider a user's Codex configuration runs on in place of a ChatGPT login: `model_provider`
 * names a provider the same file defines in `[model_providers]`, other than `openai`, that says
 * `requires_openai_auth = false` itself. That is how an embedder routes a machine's Codex through
 * its own gateway (a `CODEX_HOME` naming its provider). Anything else is undefined: a ChatGPT
 * login, a built-in provider, one that leaves OpenAI auth unsaid, or one with a value
 * `PROVIDER_SCHEMA` won't write. What is kept is only what the schema allows.
 */
export const ownCodexProvider = (
  user: Readonly<Record<string, unknown>>,
): OwnCodexProvider | undefined => {
  const name = own(user, "model_provider");
  if (typeof name !== "string" || name === "" || name === "openai") return undefined;
  const source = own(own(user, "model_providers"), name);
  if (!isTable(source) || own(source, "requires_openai_auth") !== false) return undefined;
  const table: Record<string, unknown> = {};
  for (const [key, write] of PROVIDER_SCHEMA) {
    if (!Object.hasOwn(source, key)) continue;
    const value = write(source[key]);
    if (value === invalid) return undefined;
    table[key] = value;
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
      const provider = ownCodexProvider(await readUserConfig(source));
      return provider === undefined ? undefined : { name: provider.name, env: provider.env };
    } catch {
      return undefined;
    }
  });

/**
 * Whether anything is at the gated home's login path, of any kind; nothing there is read. A gated
 * home on a machine's own provider holds no login file, and Gram never removes one: with anything
 * there it refuses to start, and leaves it as it is.
 */
const somethingAt = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/**
 * The native gated home shares only the login file, by path. Never read or copy auth: Codex owns
 * its contents and refresh. Keep an allowlist of configuration rather than inheriting profiles,
 * providers, hooks, plugins, rules, project trust or permission overrides. Future CLI options
 * therefore cannot silently opt this home out of its exec-policy backstop.
 *
 * A machine whose Codex runs on its own provider with no ChatGPT login (`ownedCodexProvider`)
 * gets the same home with that one provider kept in place of ChatGPT's, and no login file: no
 * `auth.json` is linked, copied or removed, and anything at that path refuses the start. Its
 * exec-policy backstop and everything else above are the same.
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
      const provider = (await hasLogin(source)) ? undefined : ownCodexProvider(user);
      if (provider === undefined && requireAuth && !(await stat(auth)).isFile())
        throw new Error("Native login file missing");
      await assertOwnedCodexPath(target, true);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
      await assertOwnedCodexPath(join(target, "config.toml"));
      await assertOwnedCodexPath(join(target, "rules"), true);
      await rm(join(target, "rules", OUTWARD_RULES_FILE), { force: true });
      const link = join(target, "auth.json");
      if (provider !== undefined) {
        // Its own provider authenticates itself. No login file is linked, and none is removed:
        // one there (a link from when the machine had a login, or anything else) refuses.
        if (await somethingAt(link)) throw new Error("A login file is in the gated home");
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
      // A machine's gateway may refuse hosted search (for example, when it cannot bound its
      // server-side work). Keep its explicit opt-out when preparing the gated home.
      if (provider !== undefined && user["web_search"] === "disabled") {
        config["web_search"] = "disabled";
      }
      const servers = user["mcp_servers"];
      if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
        const { [APP_TOOLS_SERVER_NAME]: _ours, ...rest } = servers as Record<string, unknown>;
        config["mcp_servers"] = rest;
      }
      Object.assign(config, {
        ...(provider === undefined
          ? {
              model_provider: "openai",
              openai_base_url: "https://chatgpt.com/backend-api/codex",
              forced_login_method: "chatgpt",
              cli_auth_credentials_store: "file",
            }
          : // That one provider, as the user's configuration defines it, and no other.
            {
              model_provider: provider.name,
              model_providers: { [provider.name]: provider.table },
            }),
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
