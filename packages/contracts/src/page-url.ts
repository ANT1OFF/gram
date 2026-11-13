import { loopbackUrl } from "./preview.ts";

// Where a pinned page loads from, for the server, the shell and the web app. Schema-free, for the
// shell's main process. A pinned page is a folder the user pinned from the Preview tab, copied into
// Gram's own state (`pages.ts`), served by a listener of its own on loopback (`PageFiles` in the
// server) and shown in a session of its own (`gram-pages`, the shell's `modules/pages`), which no
// agent tool reaches.

/**
 * The first path segment of every URL the page listener serves:
 * `http://127.0.0.1:<port>/gram-pages/<token>/<file>`. Its port is picked at start.
 */
export const PAGES_SEGMENT = "gram-pages";

/**
 * The message the server sends the desktop shell over its parent port, `{ type, origin }`, once
 * its page listener is up: the one origin the shell's `gram-pages` session loads.
 */
export const PAGES_ORIGIN_MESSAGE = "pages.origin";

/** The origin a `PAGES_ORIGIN_MESSAGE` names, unchecked; `undefined` for any other message. */
export function pagesOriginFromMessage(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return undefined;
  return Reflect.get(message, "type") === PAGES_ORIGIN_MESSAGE
    ? Reflect.get(message, "origin")
    : undefined;
}

/** The partition of the session pinned pages run in: in memory, no `persist:` prefix. */
export const PAGES_PARTITION = "gram-pages";

/** A page's token in its URLs: unguessable, minted by the listener for one pinned version. */
const PAGE_TOKEN = /^[A-Za-z0-9_-]{24,64}$/;

/**
 * Whether `raw` is a loopback URL under `PAGES_SEGMENT`, whatever its port or the case and escapes
 * of that segment: what the Preview tab's local session, `show_panel` and the browser tools refuse,
 * so no agent ever opens, reads or drives a pinned page.
 */
export function isPinnedPageUrl(raw: string): boolean {
  const url = loopbackUrl(raw);
  if (url === undefined) return false;
  const first = new URL(url).pathname.split("/")[1] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // An escape that doesn't decode is not a name the listener answers, but refuse it anyway.
    return true;
  }
  return decoded.toLowerCase() === PAGES_SEGMENT;
}

/**
 * A pinned page's URL taken apart, when `raw` is one on exactly `origin` (the listener's, as the
 * server announced it): its token, and the prefix every URL of that page starts with. `undefined`
 * for anything else, another port, a query, a user name or an escaped segment included.
 */
export function pinnedPageOn(
  origin: string,
  raw: string,
): { readonly token: string; readonly prefix: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || url.origin !== origin) return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "") return undefined;
  const [, segment, token, ...rest] = url.pathname.split("/");
  if (segment !== PAGES_SEGMENT || token === undefined || !PAGE_TOKEN.test(token)) return undefined;
  if (rest.length === 0 || rest.some((part) => part === "" || part.startsWith("."))) {
    return undefined;
  }
  return { token, prefix: `${origin}/${PAGES_SEGMENT}/${token}/` };
}

/**
 * The policy every pinned page runs under, from the listener at `origin`: its own scripts run; its
 * scripts, styles, images, fonts and media load from the listener alone (or `data:` and `blob:`);
 * it fetches nothing, frames nothing and posts nothing. `sandbox allow-scripts` gives each of its
 * documents an opaque origin of its own: no cookies, storage, popups, forms, downloads, modals or
 * top navigation, and no reach into a frame it makes. The server sends it and the shell's session
 * puts it on every response again, so neither half alone holds the page in.
 */
export function pagePolicyHeaders(origin: string): Readonly<Record<string, string>> {
  return {
    "content-security-policy": [
      "default-src 'none'",
      `script-src ${origin} 'unsafe-inline' 'unsafe-eval' data: blob:`,
      `style-src ${origin} 'unsafe-inline' data:`,
      `img-src ${origin} data: blob:`,
      `font-src ${origin} data:`,
      `media-src ${origin} data: blob:`,
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "manifest-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "sandbox allow-scripts",
    ].join("; "),
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=()",
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "referrer-policy": "no-referrer",
  };
}

/** Where on the window a pinned page is drawn, in the app page's CSS pixels. */
export interface PageBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A pinned page's view, as the shell reports it. */
export interface PageViewState {
  readonly loading: boolean;
  /** Why it isn't showing: it didn't load, or its renderer stopped. */
  readonly error?: string | undefined;
}

/**
 * `window.gram.pages`: pinned pages, each in a view of its own in the `gram-pages` session, drawn
 * over the Pages tab's placeholder. `key` names one page's view (its id). Absent from shells that
 * predate pinned pages.
 */
export interface DesktopPages {
  /**
   * Loads `url`, a page listener URL the server gave (`pages.open`), in `key`'s view; false when
   * the shell refuses it, as it does anything not on the listener's own origin.
   */
  open(key: string, url: string): Promise<boolean>;
  /** Shows `key`'s view at `bounds` in this window; `null` takes it out, keeping it loaded. */
  setBounds(key: string, bounds: PageBounds | null): void;
  reload(key: string): void;
  /** Closes `key`'s view, as after an unpin. */
  close(key: string): void;
  /** Subscribes to `key`'s view changing; returns the unsubscribe function. */
  onState(key: string, callback: (state: PageViewState) => void): () => void;
}
