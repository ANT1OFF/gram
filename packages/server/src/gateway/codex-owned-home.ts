import { chmod, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OUTWARD_RULES_FILE } from "./codex-home.ts";
import { assertOwnedCodexPath } from "./codex-owned-path.ts";
import { APP_TOOLS_SERVER_NAME } from "@gram/agents";
import { realPathOrOwned } from "@gram/git";
import * as Effect from "effect/Effect";
import { parse, stringify } from "smol-toml";

/**
 * The native gated home shares only the login file, by path. Never read or copy auth: Codex owns
 * its contents and refresh. Keep an allowlist of configuration rather than inheriting profiles,
 * providers, hooks, plugins, rules, project trust or permission overrides. Future CLI options
 * therefore cannot silently opt this home out of its exec-policy backstop.
 */
export const prepareOwnedCodexHome = (
  dataDir: string,
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  requireAuth = true,
): Effect.Effect<string> =>
  Effect.promise(async () => {
    try {
      const source = resolve(env["CODEX_HOME"] ?? join(home, ".codex"));
      const target = resolve(dataDir, "codex-owned-home");
      if (source === target || (await realPathOrOwned(source)) === (await realPathOrOwned(target)))
        throw new Error("Native and owned homes coincide");
      const auth = join(source, "auth.json");
      if (requireAuth && !(await stat(auth)).isFile()) throw new Error("Native login file missing");
      await assertOwnedCodexPath(target, true);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
      await assertOwnedCodexPath(join(target, "config.toml"));
      await assertOwnedCodexPath(join(target, "rules"), true);
      await rm(join(target, "rules", OUTWARD_RULES_FILE), { force: true });
      const link = join(target, "auth.json");
      if ((await readlink(link).catch(() => undefined)) !== auth) {
        // A CLI may replace its credential file on refresh. Restore the link before every open.
        await rm(link, { force: true });
        await symlink(auth, link, "file");
      }
      const text = await readFile(join(source, "config.toml"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        },
      );
      const user = parse(text);
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
        model_provider: "openai",
        openai_base_url: "https://chatgpt.com/backend-api/codex",
        forced_login_method: "chatgpt",
        cli_auth_credentials_store: "file",
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
