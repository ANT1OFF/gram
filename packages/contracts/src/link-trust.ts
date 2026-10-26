/**
 * Which links may open without the "Open external link?" question. Trust is per exact host, as the
 * WHATWG URL parser reads it: lowercased, an IDN in its punycode form, never a suffix or a wildcard,
 * so trusting `docs.example.com` trusts neither `evil.example.com` nor
 * `docs.example.com.evil.com`. Only a plain https link can skip the question: http, a user
 * name or password before the host, or a port other than 443 always asks.
 */

/** Why a link to an http(s) host always asks, even when that host is trusted. */
export type UntrustableReason = "http" | "userinfo" | "port";

/** Why a link asks every time, in the link question's words. */
export const ALWAYS_ASKS_BECAUSE: Record<UntrustableReason, string> = {
  http: "It isn't https, so it asks every time.",
  userinfo: "The part before “@” is a user name, not the site. Links carrying one ask every time.",
  port: "It names a port of its own, so it asks every time.",
};

/** What the link question shows about where a link goes. */
export interface LinkHost {
  /** The host the browser will connect to: lowercased, an IDN as punycode. */
  readonly host: string;
  /**
   * The host as the link spells it, when that is more than a change of case away from `host`: an
   * IDN, or percent-escapes. A look-alike shows up as the difference between the two.
   */
  readonly written?: string | undefined;
  /** Set when the link can't be trusted by its host, so the question offers no "always". */
  readonly untrustable?: UntrustableReason | undefined;
}

/**
 * The authority's host as written: after any `user@`, before any port, path, query or fragment.
 * Sliced rather than matched, since the link is untrusted text and a backtracking pattern over it
 * can be made to run for ages.
 */
function writtenHost(url: string): string | undefined {
  // Only the slashes right after the scheme open an authority: `https:foo//bar` goes to `foo`,
  // and with no slashes there the parsed host is all there is to show.
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(url)?.[0];
  if (scheme === undefined) return undefined;
  const slashes = url.slice(scheme.length, scheme.length + 2);
  if (!/^[/\\]{2}$/.test(slashes)) return undefined;
  const rest = url.slice(scheme.length + 2);
  const end = rest.search(/[/\\?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostPort.startsWith("[")
    ? hostPort.slice(0, hostPort.indexOf("]") + 1)
    : hostPort.split(":", 1)[0];
  return host === undefined || host === "" ? undefined : host.toLowerCase();
}

/** Where `url` goes, or `null` for anything that isn't an absolute http(s) URL. */
export function linkHost(url: string): LinkHost | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname;
  if (host === "") return null;
  const written = writtenHost(url.trim());
  const untrustable: UntrustableReason | undefined =
    parsed.protocol !== "https:"
      ? "http"
      : parsed.username !== "" || parsed.password !== ""
        ? "userinfo"
        : parsed.port !== ""
          ? "port"
          : undefined;
  return {
    host,
    ...(written === undefined || written === host ? {} : { written }),
    ...(untrustable === undefined ? {} : { untrustable }),
  };
}

/** Whether `host` is one a link can be trusted by: exactly what `linkHost` gives for an https URL. */
export function isTrustableHost(host: unknown): host is string {
  if (typeof host !== "string" || host === "" || host.includes("*")) return false;
  try {
    const parsed = new URL(`https://${host}/`);
    return parsed.hostname === host && parsed.port === "" && parsed.username === "";
  } catch {
    return false;
  }
}

/** Whether `url` opens without asking: a plain https link to one of the `trusted` hosts. */
export function isTrustedLink(url: string, trusted: Iterable<string>): boolean {
  const link = linkHost(url);
  if (link === null || link.untrustable !== undefined) return false;
  for (const host of trusted) if (host === link.host) return true;
  return false;
}

/** A stored trusted-host list, cleaned: trustable hosts only, each once, sorted. */
export function trustedHostsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isTrustableHost))].toSorted();
}
