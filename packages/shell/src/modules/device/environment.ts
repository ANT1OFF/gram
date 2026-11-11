/**
 * The environment a lent machine's command runs with: the one Gram probed from the person's login
 * shell, minus variables that read as credentials. This is hygiene, not a boundary: it misses what
 * it doesn't know, and a command can read the same values from files. The part that holds is on
 * the way out, where the exact values removed here are redacted from what the command prints.
 */

/** Name segments that mark a credential, matched between `_` separators. */
const CREDENTIAL_SEGMENTS = new Set([
  "TOKEN",
  "TOKENS",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PWD",
  "KEY",
  "KEYS",
  "APIKEY",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "PAT",
  "DSN",
  "SESSION",
  "COOKIE",
  "AUTH",
  "SIGNATURE",
  "PRIVATE",
]);

/**
 * Names removed whatever their segments say: they lend the person's signing agent, raise a
 * password window, or point a tool at a credential store.
 */
const ALWAYS_REMOVED = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "GIT_ASKPASS",
  "GPG_AGENT_INFO",
]);

/** Names kept though a segment matches: they hold no secret and tools break without them. */
const ALWAYS_KEPT = new Set([
  "PWD",
  "OLDPWD",
  "TOKENIZERS_PARALLELISM",
  "XDG_SESSION_TYPE",
  "XDG_SESSION_CLASS",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
]);

/** A URL with a password in it, as in `postgres://app:hunter2@db/app`. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;

const credentialName = (name: string): boolean => {
  const upper = name.toUpperCase();
  if (ALWAYS_KEPT.has(upper)) return false;
  if (ALWAYS_REMOVED.has(upper)) return true;
  return upper.split(/[^A-Z0-9]+/).some((segment) => CREDENTIAL_SEGMENTS.has(segment));
};

export interface FilteredEnvironment {
  readonly env: Record<string, string>;
  /** The names removed, for the person's own record; never their values. */
  readonly removed: ReadonlyArray<string>;
  /** The values removed that are long enough to redact from output without eating ordinary text. */
  readonly secrets: ReadonlyArray<string>;
}

/** Values shorter than this aren't redacted: `1` or `true` would blank half of any output. */
export const REDACT_MIN_LENGTH = 8;

export const filterEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): FilteredEnvironment => {
  const kept: Record<string, string> = {};
  const removed: Array<string> = [];
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (credentialName(name) || URL_WITH_PASSWORD.test(value)) {
      removed.push(name);
      if (value.length >= REDACT_MIN_LENGTH) secrets.add(value);
      continue;
    }
    kept[name] = value;
  }
  return { env: kept, removed: removed.toSorted(), secrets: [...secrets] };
};

export const REDACTED = "[removed by Gram]";

/**
 * Redacts `secrets` from text that arrives in chunks. A secret cut across two chunks is still
 * caught: the redactor holds back the longest tail that could be the start of one, and `end`
 * gives what was held.
 */
export const makeRedactor = (
  secrets: ReadonlyArray<string>,
): { readonly push: (chunk: string) => string; readonly end: () => string } => {
  // Longest first, so a secret that contains another is taken whole.
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length >= REDACT_MIN_LENGTH)
    .toSorted((a, b) => b.length - a.length);
  if (ordered.length === 0) return { push: (chunk) => chunk, end: () => "" };
  const redact = (text: string): string => {
    let out = text;
    for (const secret of ordered) out = out.split(secret).join(REDACTED);
    return out;
  };
  /** How much of `text`'s end is a proper prefix of some secret, and so can't be let go yet. */
  const heldBack = (text: string): number => {
    const most = Math.min(text.length, (ordered[0]?.length ?? 1) - 1);
    for (let length = most; length > 0; length -= 1) {
      const tail = text.slice(text.length - length);
      if (ordered.some((secret) => secret.startsWith(tail))) return length;
    }
    return 0;
  };
  let held = "";
  return {
    push: (chunk) => {
      const text = redact(held + chunk);
      const keep = heldBack(text);
      held = text.slice(text.length - keep);
      return text.slice(0, text.length - keep);
    },
    end: () => {
      const rest = held;
      held = "";
      return rest;
    },
  };
};
