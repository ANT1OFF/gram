import { pinnedPageOn } from "@gram/contracts/link-trust";

const PAGE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const isPageKey = (value: unknown): value is string =>
  typeof value === "string" && PAGE_KEY.test(value);

/**
 * The page listener's origin as the server announced it: `http://127.0.0.1:<port>` exactly, or
 * `undefined` for anything else, which leaves pinned pages unable to load at all.
 */
export function pageListenerOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(raw);
  if (match === null) return undefined;
  const port = Number(match[1]);
  return port > 0 && port < 65_536 ? `http://127.0.0.1:${port}` : undefined;
}

/** The prefix every URL of the page at `url` starts with, when it is one on `origin`. */
export function pagePrefixOf(origin: string | undefined, url: unknown): string | undefined {
  if (origin === undefined || typeof url !== "string") return undefined;
  return pinnedPageOn(origin, url)?.prefix;
}

const LOCAL = /^(data|blob):/i;

/**
 * Whether one request of a page whose URLs start with `prefix` goes out: a GET or HEAD of its own
 * files, or its own `data:` and `blob:` URLs. Nothing else, another page's files on the same
 * listener included.
 */
export function pageRequest(
  prefix: string | undefined,
  request: { readonly url: string; readonly method: string },
): "allow" | "block" {
  if (prefix === undefined) return "block";
  if (LOCAL.test(request.url)) return "allow";
  if (request.method !== "GET" && request.method !== "HEAD") return "block";
  return withinPrefix(prefix, request.url) ? "allow" : "block";
}

/** Whether a navigation of the page's frame stays in its own files, which is all it may load. */
export const pageNavigation = (prefix: string | undefined, url: string): "load" | "block" =>
  prefix !== undefined && withinPrefix(prefix, url) ? "load" : "block";

const withinPrefix = (prefix: string, url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") return false;
  const href = `${parsed.origin}${parsed.pathname}`;
  return href.startsWith(prefix) && href.length > prefix.length;
};
