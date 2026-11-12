// What the Preview tab's pages may load (`modules/preview/main.ts` applies it). A thread's page lives
// in one of two sessions. The local one holds loopback pages, and agents' pages: it loads loopback
// and nothing else (`previewRequest`), and the agent browser's own rules decide for an agent's page
// off it. The web one holds the pages the user opens anywhere else, and no agent ever drives or
// reads it: any http(s) page loads there, but never a loopback address, and a page never reaches a
// network more private than its own (`webRequest`), so a site can't use the pane to reach Gram's own
// server, a dev server or the office network. A page it loads is untrusted, so every request it
// makes is checked, its subresources and redirects too.

import {
  LOOPBACK_HOSTS,
  isPrivateAddress,
  refusedHost,
  type PreviewBounds,
} from "@gram/contracts/link-trust";

import { isThreadIdArg } from "./rules.ts";

/** What happens to a page the preview is asked to navigate to. */
export type PreviewNavigation =
  /** A page on this computer's loopback (`localhost`, `127.0.0.1`, `[::1]`), loaded as written. */
  | "load"
  /** A web page elsewhere: it opens in the thread's web session (`webNavigation`). */
  | "web"
  /** Anything else (`file:`, `javascript:`, `data:`, `chrome:`, `devtools:`): nothing opens. */
  | "refuse";

/** What happens to one request the preview's page makes, a navigation or a subresource. */
export type PreviewRequest = "allow" | "block";

const WEB = new Set(["http:", "https:"]);
const SOCKETS = new Set(["ws:", "wss:"]);
/** Schemes that never reach the network: the page's own data and blobs. */
const LOCAL = new Set(["data:", "blob:"]);
const DEFAULT_PORT: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** The loopback port `url` names, or `undefined` when it isn't a web or socket URL on loopback. */
export function loopbackPortOf(url: string): number | undefined {
  const parsed = parse(url);
  if (parsed === undefined || !LOOPBACK_HOSTS.has(parsed.hostname)) return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  const fallback = DEFAULT_PORT[parsed.protocol];
  if (fallback === undefined) return undefined;
  return parsed.port === "" ? fallback : Number(parsed.port);
}

/** Where a navigation of the preview's own page goes: a click, a redirect, `location =`. */
export function previewNavigation(url: string): PreviewNavigation {
  const parsed = parse(url);
  if (parsed === undefined) return "refuse";
  if (parsed.href === "about:blank") return "load";
  if (!WEB.has(parsed.protocol)) return "refuse";
  if (loopbackPortOf(url) !== undefined) return "load";
  // A user name before the host, on loopback or not, is how a look-alike hides: the web session
  // refuses it, and the address strip never takes one.
  if (parsed.username !== "" || parsed.password !== "") return "refuse";
  return "web";
}

/** Whether the local session lets one request through, as its `webRequest` sees it. */
export function previewRequest(url: string): PreviewRequest {
  const parsed = parse(url);
  if (parsed === undefined) return "block";
  if (LOCAL.has(parsed.protocol)) return "allow";
  if (!WEB.has(parsed.protocol) && !SOCKETS.has(parsed.protocol)) return "block";
  return loopbackPortOf(url) === undefined ? "block" : "allow";
}

// ---------------------------------------------------------------------------------------------
// The web session

/**
 * How private the network an address is on: this computer, a private network (the office, home,
 * a VPN), or the internet. A request may reach its own page's zone or a more public one only.
 */
export type NetworkZone = "public" | "private" | "loopback";

const RANK: Readonly<Record<NetworkZone, number>> = {
  public: 0,
  private: 1,
  loopback: 2,
};

/** The more public of two zones. */
export const morePublic = (a: NetworkZone, b: NetworkZone): NetworkZone =>
  RANK[a] <= RANK[b] ? a : b;

/** Whether a request to `target` stays within `bound`, the most private zone it may reach. */
export const withinZone = (target: NetworkZone, bound: NetworkZone): boolean =>
  RANK[target] <= RANK[bound];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv4 address's zone; `0.0.0.0` reaches this computer on macOS and Linux. */
const ipv4Zone = (address: string): NetworkZone | undefined => {
  const match = IPV4.exec(address);
  if (match === null) return undefined;
  const first = Number(match[1]);
  if (first === 127 || first === 0) return "loopback";
  return isPrivateAddress(address) ? "private" : "public";
};

/** An IPv6 address's zone, unbracketed, as DNS or the URL parser spells it. */
const ipv6Zone = (raw: string): NetworkZone => {
  const address = raw.toLowerCase();
  if (address === "::1" || address === "::") return "loopback";
  const mapped = /^::ffff:(.+)$/.exec(address)?.[1];
  if (mapped !== undefined) {
    const dotted = ipv4Zone(mapped);
    if (dotted !== undefined) return dotted;
    // The parser writes a mapped address in hex (`::ffff:7f00:1`).
    const hex = /^([\da-f]{1,4}):([\da-f]{1,4})$/.exec(mapped);
    if (hex === null) return "private";
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return ipv4Zone(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`) ?? "private";
  }
  return isPrivateAddress(address) ? "private" : "public";
};

/** The zone of an address a name resolved to, as DNS gives it. */
export function addressZone(address: string): NetworkZone {
  const v4 = ipv4Zone(address);
  if (v4 !== undefined) return v4;
  if (!address.includes(":")) return "private";
  // Compressed as the URL parser writes it (`0:0:0:0:0:0:0:1` is `::1`); one it can't read, such
  // as a link-local address with its zone (`fe80::1%en0`), counts as private.
  let compressed: string;
  try {
    compressed = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return "private";
  }
  return ipv6Zone(compressed);
}

/**
 * The zone of a URL's host by its name alone, as the URL parser spells it: loopback for
 * `localhost`, any name under it and the loopback addresses; private for a private address and a
 * name only a private network resolves (`intranet`, `nas.local`, `wiki.corp`); else public, until
 * its name resolves (`addressZone`).
 */
export function hostZone(rawHost: string): NetworkZone {
  const host = (rawHost.endsWith(".") ? rawHost.slice(0, -1) : rawHost).toLowerCase();
  if (LOOPBACK_HOSTS.has(host) || host === "localhost" || host.endsWith(".localhost"))
    return "loopback";
  if (host.startsWith("[") && host.endsWith("]")) return ipv6Zone(host.slice(1, -1));
  const v4 = ipv4Zone(host);
  if (v4 !== undefined) return v4;
  return refusedHost(host) === "private" ? "private" : "public";
}

/** Whether a host is an address already, which needs no lookup. */
const isAddress = (host: string) => IPV4.test(host) || host.startsWith("[");

/**
 * The zone a page or a request's initiator is in, from its URL or origin: an opaque origin
 * (`null`, a sandboxed frame or a `data:` page) or anything unreadable could be from anywhere, so
 * it counts as public.
 */
export function zoneOf(urlOrOrigin: string | undefined): NetworkZone {
  if (urlOrOrigin === undefined || urlOrOrigin === "null") return "public";
  const parsed = parse(urlOrOrigin);
  if (parsed === undefined || !(WEB.has(parsed.protocol) || SOCKETS.has(parsed.protocol)))
    return "public";
  return hostZone(parsed.hostname);
}

/** What the web session does with one request. */
export type WebRequestVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "block" }
  /** Allowed if every address `host` resolves to is within `bound`. */
  | {
      readonly kind: "resolve";
      readonly host: string;
      readonly bound: NetworkZone;
    };

/** One request a page in the web session makes, with what the session knows of where it's from. */
/**
 * Which web session a page is in, by the network its page is on: the shared one for the internet,
 * which never reaches a private network, or a private network page's own (`modules/preview`).
 */
export type WebNetwork = "public" | "private";

/** The web session a page at `url` opens in: a private address or name's own, else the shared one. */
export function webNetworkOf(url: string): WebNetwork {
  const parsed = parse(url);
  return parsed !== undefined && hostZone(parsed.hostname) === "private" ? "private" : "public";
}

export interface WebRequestDetails {
  readonly url: string;
  readonly mainFrame: boolean;
  /** A frame inside the page navigating. */
  readonly subFrame?: boolean | undefined;
  /** The session the request is made in; the shared, public one when absent. */
  readonly network?: WebNetwork | undefined;
  /** The origin of the page or frame that started it; absent for a load the app started. */
  readonly initiator?: string | undefined;
  /** For a main frame's redirect, the URL it was redirected from. */
  readonly before?: string | undefined;
  /** The page's main frame's URL now, for a subresource with no initiator. */
  readonly page?: string | undefined;
}

/**
 * A web session's rule for one request. Never loopback, whoever asks: Gram's own server, the
 * user's dev servers and the agents' pages are the local session's. Never a private network in the
 * shared session; a private network page's own session loads no public page or frame. Within that,
 * anything a page starts, a link, a form, a redirect, a script, a subresource or a frame, reaches
 * its own zone or a more public one. A public name is looked up, so one pointed at a private or loopback address (DNS
 * rebinding) is refused like the address itself.
 */
export function webRequest(request: WebRequestDetails): WebRequestVerdict {
  const parsed = parse(request.url);
  if (parsed === undefined) return { kind: "block" };
  if (LOCAL.has(parsed.protocol)) return request.mainFrame ? { kind: "block" } : { kind: "allow" };
  if (!WEB.has(parsed.protocol) && !(SOCKETS.has(parsed.protocol) && !request.mainFrame))
    return { kind: "block" };
  if (parsed.username !== "" || parsed.password !== "") return { kind: "block" };
  const host = parsed.hostname;
  const target = hostZone(host);
  if (target === "loopback") return { kind: "block" };
  // The shared session never reaches a private network, whoever asks. A private network page's
  // own session runs nothing but private pages: no public page or frame, which it hands to the
  // shared session or doesn't load, so whatever runs there already has the private network's reach.
  if ((request.network ?? "public") === "public") {
    if (target !== "public") return { kind: "block" };
  } else if (target === "public" && (request.mainFrame || request.subFrame === true)) {
    return { kind: "block" };
  }
  // Where it came from: the page or frame that started it, and a redirect's previous hop. A main
  // frame from neither is the user's own load; a subresource from neither counts as public.
  const sources = (
    request.mainFrame ? [request.initiator, request.before] : [request.initiator ?? request.page]
  ).filter((source) => source !== undefined);
  const bound =
    sources.length === 0 && request.mainFrame
      ? "private"
      : sources.map(zoneOf).reduce(morePublic, sources.length === 0 ? "public" : "private");
  if (!withinZone(target, bound)) return { kind: "block" };
  if (isAddress(host)) return { kind: "allow" };
  return { kind: "resolve", host, bound };
}

/** Looks a host up, as the web session's proxy and its request check both do. */
export type WebLookup = (host: string) => Promise<readonly string[]>;

/**
 * Whether every address `host` resolves to is within `bound`. Fails closed: a lookup that throws,
 * rejects or answers nothing allows nothing.
 */
export async function resolvedWithin(
  lookup: WebLookup,
  host: string,
  bound: NetworkZone,
): Promise<boolean> {
  let addresses: readonly string[];
  try {
    addresses = await lookup(host);
  } catch {
    return false;
  }
  return (
    Array.isArray(addresses) &&
    addresses.length > 0 &&
    addresses.every(
      (address) => typeof address === "string" && withinZone(addressZone(address), bound),
    )
  );
}

/** A host as the URL parser spells it (`[fd00::1]`, `10.0.0.1`), or `undefined` if it isn't one. */
export function hostnameOf(host: string): string | undefined {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    return new URL(`http://${bracketed}/`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The addresses a web session's proxy may connect to for one connection, in order, or `undefined`
 * to refuse it. The proxy resolves the name itself and connects to what this returns, so the
 * address checked is the address used. Never loopback. A public name answering any private or
 * loopback address (a rebound one) is refused whole, as is a name that answers nothing. A private
 * address or name only for `allowPrivate`, a private network page's own session; the shared
 * session's proxy never reaches one, whatever asks: a page, WebRTC, a preconnect.
 */
export function proxyTargets(
  host: string,
  addresses: readonly string[] | undefined,
  allowPrivate = false,
): readonly string[] | undefined {
  const hostname = hostnameOf(host);
  if (hostname === undefined) return undefined;
  const named = hostZone(hostname);
  if (named === "loopback") return undefined;
  if (named === "private" && !allowPrivate) return undefined;
  if (isAddress(hostname)) {
    const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    return addressZone(literal) === "loopback" ? undefined : [literal];
  }
  if (addresses === undefined || addresses.length === 0) return undefined;
  const ok = addresses.every((address) => {
    const zone = addressZone(address);
    return zone !== "loopback" && withinZone(zone, named);
  });
  return ok ? addresses : undefined;
}

/** Where a navigation of a page in the web session goes. */
export type WebNavigation =
  /** Any http(s) page off loopback, its requests still held to `webRequest`. */
  | "load"
  /** A loopback page, which the web session never loads: it goes to the link question. */
  | "local"
  | "refuse";

/** Where a main-frame navigation of a page in the web session goes: a click, `location =`. */
export function webNavigation(url: string): WebNavigation {
  const parsed = parse(url);
  if (parsed === undefined) return "refuse";
  if (parsed.href === "about:blank") return "load";
  if (!WEB.has(parsed.protocol)) return "refuse";
  if (parsed.username !== "" || parsed.password !== "") return "refuse";
  return hostZone(parsed.hostname) === "loopback" ? "local" : "load";
}

/** How many threads' previews stay loaded at once; using a fifth closes the least recent. */
export const MAX_PREVIEWS = 4;

/**
 * The previews to close so that at most `max` stay loaded, from `recent`, least recently used
 * first: those no window shows go first, oldest first, and only then the oldest shown ones. To make
 * room for a new one, pass the others and `max - 1`, so the newcomer is never what closes.
 */
export function previewsToClose(
  recent: readonly string[],
  shown: (threadId: string) => boolean,
  max: number = MAX_PREVIEWS,
): string[] {
  const excess = recent.length - max;
  if (excess <= 0) return [];
  const hidden = recent.filter((threadId) => !shown(threadId));
  return [...hidden, ...recent.filter(shown)].slice(0, excess);
}

/** A page's `{ threadId, … }` argument's thread, or `undefined` when it names none. */
export function previewThreadOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const threadId: unknown = Reflect.get(input, "threadId");
  return isThreadIdArg(threadId) ? threadId : undefined;
}

/** No preview is drawn bigger than this on a side; anything past it is a malformed message. */
const MAX_SIDE = 32_768;

/**
 * A page's `setBounds` argument: a rectangle of finite numbers in range, `null` to hide, or
 * `undefined` for anything else, which is dropped.
 */
export function parsePreviewBounds(input: unknown): PreviewBounds | null | undefined {
  if (input === null) return null;
  if (typeof input !== "object") return undefined;
  const value = (key: string): number | undefined => {
    const n: unknown = Reflect.get(input, key);
    return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_SIDE ? n : undefined;
  };
  const x = value("x");
  const y = value("y");
  const width = value("width");
  const height = value("height");
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

/**
 * `bounds`, in the page's CSS pixels, as the window's own (DIP) rectangle: the page's zoom scales
 * them, and Electron takes whole numbers. Rounded outward, so no sliver of the placeholder shows.
 */
export function windowRect(bounds: PreviewBounds, zoom: number) {
  const left = Math.floor(bounds.x * zoom);
  const top = Math.floor(bounds.y * zoom);
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.ceil((bounds.x + bounds.width) * zoom) - left),
    height: Math.max(0, Math.ceil((bounds.y + bounds.height) * zoom) - top),
  };
}
