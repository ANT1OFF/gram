import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Scoped requirements, not GROK_CONFIG: that overlay strips auth/ui/permission settings. */
export const GROK_REQUIREMENTS = `fail_closed = true
allow_managed_hooks_only = true
[auth]
preferred_method = "oidc"
disable_api_key_auth = true
[cli]
auto_update = false
[ui]
permission_mode = "ask"
disable_bypass_permissions_mode = true
[auto_mode]
enabled = false
[permission]
rules = [{ action = "ask", tool = "any" }]
[subagents]
enabled = false
[memory]
enabled = false
[memory_v2]
enabled = false
[managed_mcps]
enabled = false
gateway_tools_enabled = false
[compat.claude]
mcps = false
hooks = false
[compat.cursor]
mcps = false
hooks = false
[compat.codex]
hooks = false
`;

/** Only called on Gram-owned provider directories; never the developer's global Grok home. */
export async function prepareGrokHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const pending = join(home, `.requirements-${randomUUID()}.toml`);
  await writeFile(pending, GROK_REQUIREMENTS, { mode: 0o600, flag: "wx" });
  await rename(pending, join(home, "requirements.toml"));
  const settings = join(home, `.config-${randomUUID()}.toml`);
  const userConfig = GROK_REQUIREMENTS.replace("fail_closed = true\n", "")
    .replace("allow_managed_hooks_only = true\n", "")
    .replace("disable_bypass_permissions_mode = true\n", "");
  await writeFile(settings, userConfig, { mode: 0o600, flag: "wx" });
  await rename(settings, join(home, "config.toml"));
}

/** Do not pass API credentials, custom endpoints or another provider's environment to Grok. */
export const grokEnvironment = (
  source: NodeJS.ProcessEnv,
  home: string,
  authPath?: string,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "USERPROFILE",
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TERM",
  ])
    if (source[key] !== undefined) env[key] = source[key];
  env.GROK_HOME = home;
  // Official CLI owns reading, refreshing and persisting this path. Gram never opens it.
  if (authPath !== undefined) env.GROK_AUTH_PATH = authPath;
  env.GROK_DISABLE_AUTOUPDATER = "1";
  env.GROK_DISABLE_API_KEY_AUTH = "1";
  // Official managed-config sync otherwise replaces requirements.toml after authentication.
  // This provider targets personal CLI logins; deployment policies are not adopted into Gram.
  env.GROK_MANAGED_CONFIG = "0";
  env.GROK_MANAGED_CONFIG_FAIL_CLOSED = "1";
  return env;
};
