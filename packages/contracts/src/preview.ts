import type {
  BrowserInspection,
  BrowserViewportPreset,
  BrowserRegion,
} from "./browser-inspection.ts";
import type { PaneResult } from "./agent-browse.ts";

// What the Preview tab may show. The user opens any web page there; what an agent or the server
// asks it to open (`show_panel`, a suggestion) stays on loopback. The server, the shell's preview
// view and the web app all read these rules, so none of them can be talked into a page another
// would refuse. Schema-free, for the shell's main process.

/** The hosts a preview may load, as the WHATWG URL parser spells them. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `raw` normalized, when it is an http(s) URL on a loopback host with no user name or password;
 * `undefined` for anything else, `organization.example.invalid` included.
 */
export function loopbackUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return LOOPBACK_HOSTS.has(url.hostname) ? url.href : undefined;
}

/**
 * `raw` normalized, when it is an http(s) URL on any host with no user name or password: what the
 * user may open in the Preview tab. `file:`, `javascript:`, `data:`, `chrome:`, `devtools:` and every
 * other scheme are `undefined`, as is a user name before the host, which is how a look-alike hides.
 */
export function webUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return undefined;
  return url.href;
}

/** A preview target as a loopback URL: a port (`3000`, `:3000`) or an http(s) localhost URL. */
export function previewUrl(target: string): string | undefined {
  const trimmed = target.trim();
  const port = /^:?(\d{1,5})$/.exec(trimmed)?.[1];
  if (port !== undefined) {
    const n = Number(port);
    return n > 0 && n < 65_536 ? `http://127.0.0.1:${n}/` : undefined;
  }
  return loopbackUrl(trimmed);
}

/** An IPv4 address, whose sites are on a local network more often than not, and served as http. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * What the Preview tab's address strip opens for what a person typed: a port, or an http(s) URL on
 * any host (`webUrl`). Without its scheme, a loopback or IPv4 address (`localhost:3000/app`) is http
 * and any other name with a dot in it (`example.com/docs`) https. A bare word, or a relative file
 * name (`README.md`), isn't an address. Only for typing: the bridge keeps to absolute URLs.
 */
export function previewAddress(input: string): string | undefined {
  const trimmed = input.trim();
  if (/^:?\d+$/.test(trimmed)) return previewUrl(trimmed);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return webUrl(trimmed);
  if (/\s/.test(trimmed)) return undefined;
  const local = loopbackUrl(`http://${trimmed}`);
  if (local !== undefined) return local;
  const url = webUrl(`https://${trimmed}`);
  if (url === undefined) return undefined;
  const { hostname, pathname } = new URL(url);
  if (!hostname.includes(".") || (pathname === "/" && previewFileKind(trimmed) !== undefined))
    return undefined;
  return IPV4.test(hostname) ? webUrl(`http://${trimmed}`) : url;
}

/** What the Preview tab shows a file as, by its extension; `undefined` for one it doesn't show. */
export type PreviewFileKind = "markdown" | "html";

/** `path`'s preview kind: Markdown rendered by the app, or HTML as a page in the shell's view. */
export function previewFileKind(path: string): PreviewFileKind | undefined {
  const name = path.trim().toLowerCase();
  if (/\.(md|markdown)$/.test(name)) return "markdown";
  if (/\.html?$/.test(name)) return "html";
  return undefined;
}

/**
 * A file target taken apart at its `#`: the file, and the fragment a page is opened at, such as a
 * mock's board (`…/v1.html#c-hybrid-popover`). Only an HTML page keeps one; the server is asked
 * for the file alone.
 */
export function previewFileFragment(target: string): {
  readonly path: string;
  readonly fragment: string | undefined;
} {
  const trimmed = target.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return { path: trimmed, fragment: undefined };
  const path = trimmed.slice(0, hash).trim();
  const fragment = trimmed.slice(hash + 1).trim();
  return {
    path,
    fragment: fragment === "" || previewFileKind(path) !== "html" ? undefined : fragment,
  };
}

/**
 * A preview target that is a file: an absolute path (POSIX, `~/` or a Windows drive) to Markdown
 * or HTML, an HTML page with a `#fragment` as well. A relative path is left to whoever knows the
 * thread's checkout.
 */
export function previewFileTarget(target: string): string | undefined {
  const trimmed = target.trim();
  const absolute = /^(\/|~\/|[A-Za-z]:[\\/])/.test(trimmed);
  return absolute && previewFileKind(previewFileFragment(trimmed).path) !== undefined
    ? trimmed
    : undefined;
}

/**
 * The first path segment of every URL the server's preview file listener (`PreviewFiles`) serves:
 * `http://127.0.0.1:<port>/gram-preview-files/<folder prefix>/<file>`. Its port is picked at start,
 * so this is how a shell or tool tells such a page apart.
 */
export const PREVIEW_FILES_SEGMENT = "gram-preview-files";

/**
 * Whether `raw` is a page the preview file listener serves: a loopback URL under
 * `PREVIEW_FILES_SEGMENT`, whatever its port. An agent's browser tools refuse these, so a page a
 * user opened from a card is never read or driven by an agent.
 */
export function isPreviewFilesUrl(raw: string): boolean {
  const url = loopbackUrl(raw);
  if (url === undefined) return false;
  const first = new URL(url).pathname.split("/")[1] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // Malformed escapes: refuse what can't be read, as the listener would answer it.
    return true;
  }
  return decoded.toLowerCase() === PREVIEW_FILES_SEGMENT;
}

/** The page in a window's Preview tab, as the shell reports it. */
export interface PreviewState {
  /**
   * The page's address: a loopback URL, a web page the user opened, or a public page the thread's
   * agent was allowed to open.
   */
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  /** Absent on old shells or pages without an attached, authorized browser driver. */
  readonly browserInspection?: BrowserInspection | undefined;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Why the last load failed (`ERR_CONNECTION_REFUSED`); absent while the page is fine. */
  readonly error?: string | undefined;
  /**
   * Who drives the page once the thread's agent has used it (contracts' `PaneDriver`): the agent,
   * or the user, who took over by clicking or typing in it. Absent on a page no agent touched.
   */
  readonly driver?: "agent" | "user" | undefined;
  /** What the agent said its latest input does ("Opens the Filters menu"), and when it sent it. */
  readonly action?: { readonly summary: string; readonly at: number } | undefined;
  /** The agent is recording the page as an animated GIF. */
  readonly recording?: boolean | undefined;
  /**
   * The page is in the web session, where the user's sign-ins are: one the user opened from the
   * address strip (`openWeb`), and only such a page is re-opened there.
   */
  readonly web?: boolean | undefined;
}

/** Where the Preview tab's page shows, in the window page's CSS pixels. */
export interface PreviewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `window.gram.preview`: one page per thread, drawn by the shell over the Preview tab of
 * whichever window shows it, and kept loaded, out of sight, while none does, for the most recently
 * used few threads. Its sessions are its own, kept in memory, sharing nothing with the app or the
 * user's browser: loopback pages and agents' pages in one, the web pages the user opens in another
 * that no agent ever drives or reads. A new window goes to the user's browser through the shell's
 * link question.
 */
export interface DesktopPreview {
  /** Loads `url`, a loopback URL, in `threadId`'s preview; false when refused or it can't open. */
  open(threadId: string, url: string): Promise<boolean>;
  /**
   * Loads `url`, an http(s) page off loopback (`webUrl`), in `threadId`'s preview, in the session
   * with the user's sign-ins. Only for what the user typed in the address strip, or a page they
   * opened that way being re-opened; false when refused or it can't open. Absent from shells
   * older than web pages.
   */
  openWeb?(threadId: string, url: string): Promise<boolean>;
  /**
   * Shows `threadId`'s page at `bounds` in this window, moving it from any other window that showed
   * it; `null` takes it out of this window, keeping it loaded.
   */
  setBounds(threadId: string, bounds: PreviewBounds | null): void;
  back(threadId: string): void;
  forward(threadId: string): void;
  reload(threadId: string): void;
  /** `threadId`'s page, or `null` while it has none: never opened, or closed for a newer one. */
  state(threadId: string): Promise<PreviewState | null>;
  /**
   * Gives `threadId`'s page back to its agent after the user took over. Absent from shells that
   * predate agents browsing.
   */
  handBack?(threadId: string): void;
  takeOver?(threadId: string): void;
  /** Uses the existing page capture and policy. Refuses user-file/app pages. */
  inspect?(
    threadId: string,
    target?: { ref?: string; region?: BrowserRegion },
  ): Promise<PaneResult>;
  viewport?(threadId: string, preset: BrowserViewportPreset): Promise<PaneResult>;
  /** Subscribes to `threadId`'s page changing; returns the unsubscribe function. */
  onState(threadId: string, callback: (state: PreviewState) => void): () => void;
}
