// The one scrubber for token-shaped text and secret-named fields: every server log, every copy,
// and what the shells' speech process says, go through it.

/** Object keys whose values are never logged or copied. */
export const SECRET_KEY =
  /(?:token|secret|password|passphrase|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i;

export const CENSOR = "[redacted]";

/** Token-shaped text: launch tokens in URLs, bearer credentials, provider keys, `key=value` secrets. */
const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/([?&](?:boot|token|access_token|api[-_]?key|key)=)[^&\s"'#]+/gi, `$1${CENSOR}`],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/g, `$1 ${CENSOR}`],
  [/\bsk-[\w-]{16,}/g, CENSOR],
  [/\b(?:gh[pousr]_\w{20,}|github_pat_\w{20,})/g, CENSOR],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, CENSOR],
  [
    /((?:api[-_]?key|token|secret|password|passphrase)["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;}&]+/gi,
    `$1${CENSOR}`,
  ],
];

/** `text` with token-shaped substrings replaced by `[redacted]`. */
export const redactText = (text: string): string =>
  TEXT_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

/** A copy of `value` with secret-named keys censored and token-shaped text redacted. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        SECRET_KEY.test(key) ? CENSOR : redactSecrets(v),
      ]),
    );
  }
  return value;
}

/** What stands in for a value `presentableUrl` takes out. */
export const MASKED_VALUE = "••••";

/** `url` up to its query or fragment; by index, since a backtracking pattern is quadratic here. */
const beforeQuery = (url: string) => {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
};

/** `url` without a `user:password@` after its `//`. */
const withoutUserinfo = (url: string) => {
  const start = url.indexOf("//");
  if (start === -1) return url;
  const authority = url.slice(start + 2);
  const end = authority.search(/[/@]/);
  return end !== -1 && authority[end] === "@"
    ? `${url.slice(0, start + 2)}${authority.slice(end + 1)}`
    : url;
};

/**
 * A URL with nothing in it that could be a credential: no userinfo, no fragment, and every query
 * value masked whatever its name, since a repo's `.mcp.json` can call a key anything. Token-shaped
 * text in the path goes too.
 */
export const presentableUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactText(withoutUserinfo(beforeQuery(url)));
  }
  const query = [...new Set(parsed.searchParams.keys())].map((key) => `${key}=${MASKED_VALUE}`);
  return `${parsed.protocol}//${parsed.host}${redactText(parsed.pathname)}${
    query.length === 0 ? "" : `?${query.join("&")}`
  }`;
};
