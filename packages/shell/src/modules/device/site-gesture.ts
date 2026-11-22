/**
 * Whether a hosted site's call for a turn grant follows the person's own gesture in its window:
 * Enter (or ⌘/Ctrl+Enter, which also sends; not Shift or Option, which don't) pressed or a mouse
 * button pressed there, at most `SITE_GESTURE_MS` before, on the page that is there now, and not
 * used for a grant yet, and no more than `SITE_GRANTS_PER_MINUTE` a minute. A page can't make
 * either gesture by script, so a grant can't be had without them, and one gesture gives one grant.
 */

/** How long after the person's gesture a grant may be asked for it. */
export const SITE_GESTURE_MS = 2_000;
/** The most grants one window gives in a minute, whatever the gestures. */
export const SITE_GRANTS_PER_MINUTE = 6;

/** What `before-input-event` reports, as far as it matters here. */
export interface SiteInput {
  readonly type: string;
  readonly key: string;
  readonly isAutoRepeat?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface SiteGestures {
  /** Every key the window takes, before the page sees it (`before-input-event`). */
  readonly input: (input: SiteInput) => void;
  /** A mouse button pressed in the window (`input-event`, `mouseDown`). */
  readonly pointer: () => void;
  /** The window's page went elsewhere: a gesture made before it is not this page's. */
  readonly navigated: () => void;
  /** Uses the gesture for one grant, or answers false when there is none to use. */
  readonly take: () => boolean;
}

export const makeSiteGestures = (elapsed: () => number = () => performance.now()): SiteGestures => {
  let at: number | undefined;
  const given: Array<number> = [];
  const mark = () => {
    at = elapsed();
  };
  return {
    input: (input) => {
      if (
        input.type === "keyDown" &&
        input.key === "Enter" &&
        input.isAutoRepeat !== true &&
        input.shift !== true &&
        input.alt !== true
      )
        mark();
    },
    pointer: mark,
    navigated: () => {
      at = undefined;
    },
    take: () => {
      const was = at;
      at = undefined;
      const now = elapsed();
      while (given.length > 0 && now - given[0]! >= 60_000) given.shift();
      if (was === undefined || now - was > SITE_GESTURE_MS) return false;
      if (given.length >= SITE_GRANTS_PER_MINUTE) return false;
      given.push(now);
      return true;
    },
  };
};

/**
 * Whether a call came from the site's own top page: its main frame, on the server's origin. A
 * frame of another origin inside it, or the window after it went elsewhere, asks for nothing.
 */
export const fromSitePage = (
  call: { readonly mainFrame: boolean; readonly url: string | undefined },
  origin: string,
): boolean => {
  if (!call.mainFrame || call.url === undefined) return false;
  try {
    return new URL(call.url).origin === origin;
  } catch {
    return false;
  }
};

/** A thread id as Gram makes them. */
export const siteThreadIdOf = (arg: unknown): string | undefined => {
  if (typeof arg !== "object" || arg === null) return undefined;
  const id: unknown = Reflect.get(arg, "threadId");
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
};

/** The site's own pages, and any `https:` page its sign-in goes through, stay in the window. */
export const staysIn = (url: string, origin: string): boolean => {
  try {
    const target = new URL(url);
    return target.protocol === "https:" || target.origin === origin;
  } catch {
    return false;
  }
};

/**
 * The window's title: the host it shows and the page's own title after it, or, on a page off the
 * server's origin (a sign-in elsewhere), that host and the server's, never the page's words.
 */
export const siteTitle = (url: string, origin: string, page: string): string => {
  const server = new URL(origin).host;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return server;
  }
  if (host !== server) return `${host}, not ${server}`;
  const words = page.trim().slice(0, 120);
  return words === "" ? host : `${host}: ${words}`;
};
