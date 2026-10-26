// What the Preview tab's page may load (`modules/preview/main.ts` applies it): loopback, and nothing
// else. A page it loads is untrusted, so every request it makes is checked here, its subresources and
// redirects too, and a link off loopback leaves for the user's browser through the link question.

import { LOOPBACK_HOSTS, type PreviewBounds } from "@gram/contracts/link-trust";

import { isThreadIdArg } from "./rules.ts";

/** What happens to a page the preview is asked to navigate to. */
export type PreviewNavigation =
  /** A page on this computer's loopback (`localhost`, `127.0.0.1`, `[::1]`), loaded as written. */
  | "load"
  /** A web page elsewhere: it opens in the user's browser, after the link question. */
  | "external"
  /** Anything else (`file:`, `javascript:`, `chrome:`): nothing opens. */
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
  // A user name before the host, on loopback or not, is how a look-alike hides: the link question
  // names the host it really goes to.
  return "external";
}

/** Whether the preview's session lets one request through, as its `webRequest` sees it. */
export function previewRequest(url: string): PreviewRequest {
  const parsed = parse(url);
  if (parsed === undefined) return "block";
  if (LOCAL.has(parsed.protocol)) return "allow";
  if (!WEB.has(parsed.protocol) && !SOCKETS.has(parsed.protocol)) return "block";
  return loopbackPortOf(url) === undefined ? "block" : "allow";
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
