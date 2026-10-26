// Which files are never previewed from a path an agent wrote. The UI offers only "Reveal" and
// "Copy path" for these, and the server refuses `fs.file` and `fs.image` on them outside a thread's
// checkouts even when a message names them, so a crafted path can't put a key on screen.

/** Names that hold tokens or passwords whatever folder they're in. */
const CREDENTIAL_NAMES = new Set([
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".git-credentials",
  ".dockercfg",
  ".htpasswd",
  ".boto",
  ".s3cfg",
  ".vault-token",
  ".terraformrc",
  "credentials.tfrc.json",
  // Claude Code's login, in `~/.claude` or wherever `CLAUDE_CONFIG_DIR` puts it.
  ".credentials.json",
  "credentials",
  "credentials.json",
  "secret.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "secrets.toml",
]);

/** Key, certificate-store and password-vault formats. */
const CREDENTIAL_EXTENSIONS = new Set([
  "pem",
  "key",
  "p12",
  "pfx",
  "jks",
  "keystore",
  "ppk",
  "gpg",
  "kdbx",
  "keychain",
  "keychain-db",
]);

/** Folders whose every file is a credential store or configures one. */
const CREDENTIAL_FOLDERS = [
  [".ssh"],
  [".aws"],
  [".gnupg"],
  [".azure"],
  [".kube"],
  [".docker"],
  [".password-store"],
  [".config", "gcloud"],
  [".config", "gh"],
  ["Library", "Keychains"],
] as const;

/** Files that hold an agent's login only in their own folder: Codex's and OpenCode's. */
const CREDENTIAL_FILES = [
  [".codex", "auth.json"],
  [".grok", "auth.json"],
  [".local", "share", "opencode", "auth.json"],
] as const;

/** OpenSSH's default private key names, and their `.pub` halves. */
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk|xmss)(?:\.pub)?$/;

const contains = (segments: readonly string[], folder: readonly string[]) =>
  segments.some((_, start) =>
    folder.every((part, offset) => segments[start + offset]?.toLowerCase() === part.toLowerCase()),
  );

/**
 * Whether `path` looks like it holds a secret: `.env*`, keys and certificates (`*.pem`, `*.key`,
 * `id_*` SSH keys), registry and login files (`.npmrc`, `.netrc`, …), the coding agents' logins
 * (Claude's `.credentials.json`, Codex's and OpenCode's `auth.json`), keychains, and anything in
 * a credential folder such as `~/.aws` or `~/.ssh`. Judged on the path alone, with either
 * separator; a file it misses is no more exposed than any other file the user can read.
 */
export function isCredentialPath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "");
  const name = segments.at(-1);
  if (name === undefined) return false;
  // Folders on macOS and Windows are case-insensitive, and `.ENV` is `.env` there.
  const lower = name.toLowerCase();
  if (lower.startsWith(".env") || CREDENTIAL_NAMES.has(lower) || SSH_KEY.test(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot > 0 && CREDENTIAL_EXTENSIONS.has(lower.slice(dot + 1))) return true;
  const folders = segments.slice(0, -1);
  if (CREDENTIAL_FOLDERS.some((folder) => contains(folders, folder))) return true;
  return CREDENTIAL_FILES.some(
    (file) => lower === file.at(-1) && contains(folders.slice(1 - file.length), file.slice(0, -1)),
  );
}
