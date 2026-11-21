import { userInfo } from "node:os";

/** The account this process runs as, from the directory service (getpwuid), not the env. */
export interface Account {
  readonly username: string;
  readonly homedir: string;
  readonly shell: string | null;
}

/**
 * The variables to set so `env` describes `account`: HOME, USER, LOGNAME and SHELL wherever they
 * are missing or disagree, and TMPDIR only where it is missing, since pointing it elsewhere is a
 * choice a user can make.
 */
export const userEnvFixes = (
  env: Readonly<Record<string, string | undefined>>,
  account: Account,
  tempDir: string,
): Record<string, string> => {
  const fixes: Record<string, string> = {};
  const want = (name: string, value: string | null) => {
    if (value !== null && value !== "" && env[name] !== value) fixes[name] = value;
  };
  want("HOME", account.homedir);
  want("USER", account.username);
  want("LOGNAME", account.username);
  want("SHELL", account.shell);
  if ((env["TMPDIR"] ?? "") === "" && tempDir !== "") fixes["TMPDIR"] = tempDir;
  return fixes;
};

/**
 * Applies `userEnvFixes` to `process.env` and returns what it changed, with the values it replaced.
 * `tempDir` is Electron's `app.getPath("temp")`, which on macOS is the per-user temporary directory
 * whatever TMPDIR says.
 */
export const normaliseUserEnv = (
  tempDir: string,
  account: Account = userInfo(),
): Record<string, string | undefined> => {
  const fixes = userEnvFixes(process.env, account, tempDir);
  const replaced: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(fixes)) {
    replaced[name] = process.env[name];
    process.env[name] = value;
  }
  return replaced;
};
