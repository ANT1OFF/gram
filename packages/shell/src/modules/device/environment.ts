const CREDENTIAL_SEGMENTS = new Set([
  "PASS",
  "PWD",
  "KEY",
  "KEYS",
  "CREDS",
  "PAT",
  "DSN",
  "SESSION",
  "COOKIE",
  "AUTH",
  "SIGNATURE",
  "PRIVATE",
  "JWT",
  "BEARER",
]);

const CREDENTIAL_WORDS = [
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "TOKEN",
  "SECRET",
  "APIKEY",
  "PRIVATEKEY",
  "ACCESSKEY",
  "CREDENTIAL",
  "WEBHOOK",
  "CONNECTIONSTRING",
];

const ALWAYS_REMOVED = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_PARAMETERS",
  "SSHPASS",
  "GPG_AGENT_INFO",
  "KRB5CCNAME",
]);

const GIT_CONFIG = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

const ALWAYS_KEPT = new Set([
  "PWD",
  "OLDPWD",
  "TOKENIZERS_PARALLELISM",
  "XDG_SESSION_TYPE",
  "XDG_SESSION_CLASS",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_ID",
  "TERM_SESSION_ID",
  "SESSION_MANAGER",
  "DESKTOP_SESSION",
]);

const URL_WITH_SIGN_IN = /^\s*[a-z][a-z0-9+.-]*:\/\/([^/\s@]+)@/i;

const TOKEN_NAME_LENGTH = 20;

const NAMED_SECRET =
  /(?:^|[\s;&?,])(?:password|passwd|pwd|secret|accountkey|sharedaccesskey|sharedaccesssignature|sig|token|api[-_]?key)=([^\s;&,]+)/gi;

const TOKEN_SHAPE =
  /(?:\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[abeprs]-[A-Za-z0-9-]{10,}|(?<![\w/.-])sk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.|-----BEGIN [A-Z ]*PRIVATE KEY)/;

const credentialName = (name: string): boolean => {
  const upper = name.toUpperCase();
  if (ALWAYS_KEPT.has(upper)) return false;
  if (ALWAYS_REMOVED.has(upper) || GIT_CONFIG.test(upper)) return true;
  if (upper.split(/[^A-Z0-9]+/).some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
  const compact = upper.replaceAll(/[^A-Z0-9]/g, "");
  return CREDENTIAL_WORDS.some((word) => compact.includes(word));
};

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const secretParts = (value: string): Array<string> => {
  const parts: Array<string> = [];
  const signIn = URL_WITH_SIGN_IN.exec(value)?.[1];
  if (signIn !== undefined) {
    const colon = signIn.indexOf(":");
    const secret = colon === -1 ? signIn : signIn.slice(colon + 1);
    if (colon !== -1 || secret.length >= TOKEN_NAME_LENGTH) parts.push(secret, decoded(secret));
  }
  for (const match of value.matchAll(NAMED_SECRET))
    if (match[1] !== undefined) parts.push(match[1]);
  return parts;
};

export interface FilteredEnvironment {
  readonly env: Record<string, string>;
  /** The names removed, for the person's own record; never their values. */
  readonly removed: ReadonlyArray<string>;
  /** The values removed that are long enough to redact from output without eating ordinary text. */
  readonly secrets: ReadonlyArray<string>;
}

/** Values shorter than this aren't redacted: `1` or `true` would blank half of any output. */
export const REDACT_MIN_LENGTH = 6;

export const filterEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): FilteredEnvironment => {
  const kept = new Map<string, string>();
  const removed: Array<string> = [];
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const parts = secretParts(value);
    if (credentialName(name) || parts.length > 0 || TOKEN_SHAPE.test(value)) {
      removed.push(name);
      for (const secret of [value, value.trim(), ...parts])
        if (secret.length >= REDACT_MIN_LENGTH) secrets.add(secret);
      continue;
    }
    kept.set(name, value);
  }
  return { env: Object.fromEntries(kept), removed: removed.toSorted(), secrets: [...secrets] };
};

export const REDACTED = "[removed by Gram]";

interface Node {
  readonly next: Map<number, Node>;
  readonly depth: number;
  fail: Node | undefined;
  ends: number;
  open: number;
}

/**
 * Redacts `secrets` from text that arrives in chunks, with the same result however the text is
 * cut. Every place a secret occurs is found, places that overlap are joined, and each joined
 * stretch becomes one mark. Text is held back while it could still be the start of a secret, or
 * could still start one, never more than the longest secret, and `end` gives what was held. A
 * stretch's mark goes out as soon as nothing before it can change, and what joins it later is
 * swallowed. The work is one step per character whatever the secrets are.
 *
 * Feed it text decoded with a `StringDecoder`, so a character cut across two reads isn't lost,
 * and cut output to its limit only after it has been through here.
 */
export const makeRedactor = (
  secrets: ReadonlyArray<string>,
): { readonly push: (chunk: string) => string; readonly end: () => string } => {
  const wanted = [...new Set(secrets)].filter((secret) => secret.length >= REDACT_MIN_LENGTH);
  if (wanted.length === 0) return { push: (chunk) => chunk, end: () => "" };
  const root: Node = { next: new Map(), depth: 0, fail: undefined, ends: 0, open: 0 };
  for (const secret of wanted) {
    let node = root;
    for (let index = 0; index < secret.length; index += 1) {
      const unit = secret.charCodeAt(index);
      let child = node.next.get(unit);
      if (child === undefined) {
        child = { next: new Map(), depth: node.depth + 1, fail: undefined, ends: 0, open: 0 };
        node.next.set(unit, child);
      }
      node = child;
    }
    node.ends = node.depth;
  }
  const step = (from: Node, unit: number): Node => {
    let node: Node | undefined = from;
    while (node !== undefined) {
      const child = node.next.get(unit);
      if (child !== undefined) return child;
      node = node.fail;
    }
    return root;
  };
  const queue: Array<Node> = [];
  for (const child of root.next.values()) {
    child.fail = root;
    child.open = child.next.size > 0 ? child.depth : 0;
    queue.push(child);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node === undefined) continue;
    for (const [unit, child] of node.next) {
      child.fail = node.fail === undefined ? root : step(node.fail, unit);
      if (child.ends === 0) child.ends = child.fail.ends;
      child.open = child.next.size > 0 ? child.depth : child.fail.open;
      queue.push(child);
    }
  }

  let state = root;
  let held = "";
  let heldFrom = 0;
  let seen = 0;
  let found: Array<[from: number, to: number]> = [];
  let covered = 0;

  const take = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      state = step(state, text.charCodeAt(index));
      seen += 1;
      if (state.ends === 0) continue;
      let from = seen - state.ends;
      for (let last = found.at(-1); last !== undefined && last[1] > from; last = found.at(-1)) {
        from = Math.min(from, last[0]);
        found.pop();
      }
      if (from < covered) covered = seen;
      else found.push([from, seen]);
    }
    held += text;
  };

  const release = (upTo: number): string => {
    let out = "";
    let at = Math.max(heldFrom, covered);
    const rest: Array<[number, number]> = [];
    for (const place of found) {
      if (place[1] > upTo) {
        rest.push(place);
        continue;
      }
      out += held.slice(at - heldFrom, place[0] - heldFrom) + REDACTED;
      at = place[1];
    }
    if (upTo > at) out += held.slice(at - heldFrom, upTo - heldFrom);
    held = held.slice(upTo - heldFrom);
    heldFrom = upTo;
    found = rest;
    return out;
  };

  return {
    push: (chunk) => {
      take(chunk);
      const safe = Math.max(seen - state.open, heldFrom);
      const last = found.at(-1);
      if (last === undefined || last[0] >= safe || last[1] <= safe) return release(safe);
      const out = release(last[0]) + REDACTED;
      found = [];
      covered = last[1];
      return out + release(safe);
    },
    end: () => {
      const out = release(seen);
      state = root;
      return out;
    },
  };
};
