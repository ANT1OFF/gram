/**
 * Whether a hosted site's call for a turn grant follows the person's own gesture in its window:
 * Enter pressed or a mouse button pressed there, at most `SITE_GESTURE_MS` before, and not used
 * for a grant yet. A page can't make either by script, so a grant can't be had without them, and
 * one gesture gives one grant.
 */

/** How long after the person's gesture a grant may be asked for it. */
export const SITE_GESTURE_MS = 5_000;

/** What `before-input-event` reports, as far as it matters here. */
export interface SiteInput {
  readonly type: string;
  readonly key: string;
  readonly isAutoRepeat?: boolean;
}

export interface SiteGestures {
  /** Every key the window takes, before the page sees it (`before-input-event`). */
  readonly input: (input: SiteInput) => void;
  /** A mouse button pressed in the window (`input-event`, `mouseDown`). */
  readonly pointer: () => void;
  /** Uses the gesture for one grant, or answers false when there is none to use. */
  readonly take: () => boolean;
}

export const makeSiteGestures = (elapsed: () => number = () => performance.now()): SiteGestures => {
  let at: number | undefined;
  const mark = () => {
    at = elapsed();
  };
  return {
    input: (input) => {
      if (input.type === "keyDown" && input.key === "Enter" && input.isAutoRepeat !== true) mark();
    },
    pointer: mark,
    take: () => {
      const was = at;
      at = undefined;
      return was !== undefined && elapsed() - was <= SITE_GESTURE_MS;
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
