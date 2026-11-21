import { lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { stringify } from "smol-toml";
import { envWithout, ownedConfigFolder, writePrivate } from "./owned-home.ts";

const COMPAT_CELLS = ["skills", "rules", "agents", "mcps", "hooks"] as const;

/**
 * Environment names that would put the person's own configuration back into Gram's Grok: config
 * overlays, the per-vendor compatibility switches, Claude Code's relocated home, and the switch
 * that turns folder trust off, which would run a repository's own hooks and MCP servers unasked.
 */
export const isInheritedGrokConfig = (name: string): boolean =>
  name === "GROK_CONFIG" ||
  name === "GROK_CONFIG_PATH" ||
  name === "CLAUDE_CONFIG_DIR" ||
  name === "GROK_FOLDER_TRUST" ||
  /^GROK_(CLAUDE|CURSOR|CODEX)_[A-Z_]+_ENABLED$/.test(name);

/** The configuration Gram's Grok runs on, and nothing of the person's beside it. */
export const ownedGrokConfig = (realHome: string, claudeConfigDir?: string) => ({
  cli: { auto_update: false },
  compat: {
    claude: Object.fromEntries(COMPAT_CELLS.map((cell) => [cell, false])),
    cursor: Object.fromEntries(COMPAT_CELLS.map((cell) => [cell, false])),
    codex: { skills: false, hooks: false },
  },
  toolset: { bash: { login_shell_capture: false } },
  shell_environment_policy: {
    set: {
      HOME: realHome,
      ...(claudeConfigDir === undefined ? {} : { CLAUDE_CONFIG_DIR: claudeConfigDir }),
    },
  },
});

const modifiedAt = (path: string): Promise<number | undefined> =>
  lstat(path).then(
    (found) => found.mtimeMs,
    () => undefined,
  );

const keepRotatedLogin = async (link: string, auth: string): Promise<void> => {
  const found = await lstat(link).catch(() => undefined);
  if (found === undefined) return;
  if (found.isFile() && found.mtimeMs > ((await modifiedAt(auth)) ?? -1)) {
    await rename(link, auth);
    return;
  }
  await rm(link, { force: true });
};

/**
 * Grok Build reads the person's Claude Code and Cursor settings, MCP servers, plugins, hooks and
 * allow rules from their home, and its own from `~/.grok`. Gram runs it in a home of its own whose
 * `.grok` shares only the login file, by path: never read, copied or refreshed by Gram. Commands
 * the agent runs still see the person's `HOME`. Returns the environment to start Grok with.
 */
export const prepareOwnedGrokHome = (
  dataDir: string,
  home: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<Record<string, string>> =>
  Effect.promise(async () => {
    try {
      const realHome = env["HOME"] ?? home;
      const source = resolve(env["GROK_HOME"] ?? join(realHome, ".grok"));
      const target = resolve(dataDir, "grok-owned-home");
      const grokHome = join(target, ".grok");
      await ownedConfigFolder(target, grokHome, source);
      const auth = join(source, "auth.json");
      const link = join(grokHome, "auth.json");
      if ((await readlink(link).catch(() => undefined)) !== auth) {
        await keepRotatedLogin(link, auth);
        await symlink(auth, link, "file");
      }
      await writePrivate(
        join(grokHome, "config.toml"),
        stringify(ownedGrokConfig(realHome, env["CLAUDE_CONFIG_DIR"])),
      );
      return { ...envWithout(env, isInheritedGrokConfig), HOME: target, GROK_HOME: grokHome };
    } catch {
      throw new Error(
        "Gram could not prepare its Grok Build home. Check the Gram data directory and ~/.grok.",
      );
    }
  });
