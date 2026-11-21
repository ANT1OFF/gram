import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { envWithout, ownedConfigFolder, writePrivate } from "./owned-home.ts";

/** The folder in Gram's data folder that Gram's Antigravity keeps its config and sessions in. */
export const ANTIGRAVITY_OWNED_HOME = "antigravity-owned-home";

/** Gram's Antigravity config folder (`agy acp --gemini-dir`), in `dataDir`. */
export const antigravityGeminiDir = (dataDir: string): string =>
  join(resolve(dataDir, ANTIGRAVITY_OWNED_HOME), ".gemini");

/**
 * Environment names that would put the person's own configuration back into Gram's Antigravity:
 * a config folder of their choosing, permission grants handed down, and a plugin shim folder.
 */
export const isInheritedAntigravityConfig = (name: string): boolean =>
  name === "ANTIGRAVITY_CONFIG_REL_DIR" ||
  name === "ANTIGRAVITY_PERM_GRANTS" ||
  name === "ANTIGRAVITY_PLUGIN_SHIM_DIR";

/**
 * The settings Gram's Antigravity runs on: it asks before write, shell, web and MCP tools (Gram
 * answers what its mode lets through), stays in the workspace, and has no permission rules, hooks
 * or servers of the person's.
 */
export const ownedAntigravitySettings = () => ({
  agentMode: "",
  toolPermission: "request-review",
  allowNonWorkspaceAccess: false,
  artifactReviewPolicy: "asks-for-review",
  notifications: false,
  showTips: false,
  showFeedbackSurvey: false,
});

/**
 * Antigravity reads the person's settings, permission rules, hooks, MCP servers, plugins, skills
 * and global rules from `~/.gemini`. Gram runs it on a config folder of its own
 * (`antigravityGeminiDir`) holding only the settings Gram writes; its sign-in stays in the OS
 * keyring, which Gram never touches. `HOME` stays the person's, so the commands the agent runs see
 * it. Returns the environment to start Antigravity with.
 */
export const prepareOwnedAntigravityHome = (
  dataDir: string,
  home: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<Record<string, string>> =>
  Effect.promise(async () => {
    try {
      const realHome = env["HOME"] ?? home;
      const geminiDir = antigravityGeminiDir(dataDir);
      await ownedConfigFolder(
        resolve(dataDir, ANTIGRAVITY_OWNED_HOME),
        geminiDir,
        resolve(realHome, ".gemini"),
      );
      await writePrivate(
        join(geminiDir, "antigravity-cli", "settings.json"),
        `${JSON.stringify(ownedAntigravitySettings(), null, 2)}\n`,
      );
      await writePrivate(
        join(geminiDir, "config", "mcp_config.json"),
        `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      );
      return envWithout(env, isInheritedAntigravityConfig);
    } catch {
      throw new Error(
        "Gram could not prepare its Antigravity home. Check the Gram data directory and ~/.gemini.",
      );
    }
  });
