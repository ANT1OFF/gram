import type {
  DesktopNotification,
  GridLayout,
  TitleBarTheme,
  UpdateInstallIntent,
} from "@gram/contracts";
import { isNoticeActionLabel, noticeBodyFits } from "@gram/contracts/desktop-bridge";

/** Whether `url` may be handed to the OS browser: absolute http(s) only. */
export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** A TCP port a renderer may ask to open on localhost. */
export const isPortNumber = (port: unknown): port is number =>
  typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;

/** Whether `path` may be shown in Finder / Explorer: an absolute local path, never a UNC share. */
export function isRevealablePath(path: unknown): path is string {
  if (typeof path !== "string" || path.includes("\0")) return false;
  return /^\/(?!\/)/.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/** Whether an IPC sender's page URL has one of the trusted origins (the server, or Vite in dev). */
export function isTrustedSenderUrl(
  senderUrl: string | undefined,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  if (!senderUrl) return false;
  try {
    return trustedOrigins.has(new URL(senderUrl).origin);
  } catch {
    return false;
  }
}

/** A window id the shell hands out: `w1`, `w2`… */
export function isWindowId(value: unknown): value is string {
  return typeof value === "string" && /^w\d{1,4}$/.test(value);
}

/** A thread id from a renderer: short, with no path or control characters. */
export function isThreadIdArg(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,128}$/.test(value);
}

/** A renderer's pane grid, checked loosely; the renderer owns its details. */
export function parseGridLayout(input: unknown): GridLayout | null {
  if (typeof input !== "object" || input === null) return null;
  const preset: unknown = Reflect.get(input, "preset");
  const panes: unknown = Reflect.get(input, "panes");
  if (typeof preset !== "string" || !Array.isArray(panes) || panes.length > 6) return null;
  if (!panes.every((pane) => pane === null || isThreadIdArg(pane))) return null;
  return input as GridLayout;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseTitleBarTheme(input: unknown): TitleBarTheme | null {
  if (!isRecord(input)) return null;
  const { background, foreground, mode } = input;
  if (typeof background !== "string" || !HEX_COLOR.test(background)) return null;
  if (typeof foreground !== "string" || !HEX_COLOR.test(foreground)) return null;
  if (mode !== "light" && mode !== "dark" && mode !== "system") return null;
  return { background, foreground, mode };
}

/** The title bar theme saved at the last sync, or `null` when the file is missing, not JSON or invalid. */
export function parseStoredAppearance(text: string | undefined): TitleBarTheme | null {
  if (text === undefined) return null;
  try {
    return parseTitleBarTheme(JSON.parse(text));
  } catch {
    return null;
  }
}

const MAX_NOTIFICATION_TEXT = 500;

/** An ask notification's id: a page-made token, never text the OS shows. */
const NOTIFICATION_ID = /^[\w-]{1,64}$/;
/** Allow or Merge, then the Open the shell adds. */
const MAX_NOTIFICATION_ACTIONS = 1;

/**
 * A page's notification, bounded. Answering actions are kept only on a body shown whole
 * (`noticeBodyFits`) and with an id to echo back, whatever the page asked for: the shell holds the
 * rule that an Allow never sits under a command cut short.
 */
export function parseNotification(input: unknown): DesktopNotification | null {
  if (!isRecord(input)) return null;
  const { title, body, threadId, id, subtitle, actions } = input;
  if (typeof title !== "string" || typeof body !== "string") return null;
  if (threadId !== undefined && typeof threadId !== "string") return null;
  if (id !== undefined && (typeof id !== "string" || !NOTIFICATION_ID.test(id))) return null;
  if (subtitle !== undefined && typeof subtitle !== "string") return null;
  if (actions !== undefined && (!Array.isArray(actions) || !actions.every(isNoticeActionLabel)))
    return null;
  const answers =
    id !== undefined &&
    Array.isArray(actions) &&
    actions.length > 0 &&
    actions.length <= MAX_NOTIFICATION_ACTIONS &&
    body.length <= MAX_NOTIFICATION_TEXT &&
    noticeBodyFits(body)
      ? (actions as string[])
      : undefined;
  return {
    title: title.slice(0, MAX_NOTIFICATION_TEXT),
    body: body.slice(0, MAX_NOTIFICATION_TEXT),
    ...(threadId === undefined ? {} : { threadId }),
    ...(id === undefined ? {} : { id }),
    ...(subtitle === undefined ? {} : { subtitle: subtitle.slice(0, MAX_NOTIFICATION_TEXT) }),
    ...(answers === undefined ? {} : { actions: answers }),
  };
}

/**
 * A renderer's install request, exactly: a known channel, a string tag and a boolean `downgrade`.
 * Anything looser is refused rather than defaulted, so a stale or careless caller can't reach the
 * installer with half an intent.
 */
export function parseInstallIntent(input: unknown): UpdateInstallIntent | null {
  if (!isRecord(input)) return null;
  const { channel, tag, downgrade, installId } = input;
  if (channel !== "stable" && channel !== "prerelease") return null;
  if (typeof tag !== "string" || typeof downgrade !== "boolean") return null;
  if (
    installId !== undefined &&
    (typeof installId !== "string" || !/^[a-f0-9-]{36}$/.test(installId))
  )
    return null;
  return { channel, tag, downgrade, ...(typeof installId === "string" ? { installId } : {}) };
}

/** A non-negative integer badge count; anything else clears the badge. */
export function badgeCount(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) && input > 0
    ? Math.min(Math.floor(input), 9999)
    : 0;
}

/** A 32 bpp BGRA bitmap of a filled red dot, for the Windows taskbar overlay badge. */
export function overlayDotBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const alpha = Math.round(Math.max(0, Math.min(1, r - d)) * 255);
      const i = (y * size + x) * 4;
      // Premultiplied BGRA, as nativeImage.createFromBitmap expects.
      buf[i] = Math.round((0x3b * alpha) / 255);
      buf[i + 1] = Math.round((0x3b * alpha) / 255);
      buf[i + 2] = Math.round((0xef * alpha) / 255);
      buf[i + 3] = alpha;
    }
  }
  return buf;
}

/** A permission request or check, as the session's handlers see it. */
export interface PermissionAsk {
  readonly permission: string;
  /** The page's URL (a request) or origin (a check). */
  readonly url: string | undefined;
  /** What a `media` request wants (`audio`, `video`); a check names one, or `unknown`. */
  readonly mediaTypes: readonly string[];
}

/**
 * The ask in an Electron permission request: what a `media` request wants, and the requesting
 * frame's URL or else the page's. The shell reads its requests through this, so it can't drop
 * the media types the microphone grant depends on.
 */
export function permissionRequestAsk(
  permission: string,
  details: { readonly requestingUrl?: string; readonly mediaTypes?: readonly string[] },
  pageUrl: string,
): PermissionAsk {
  return {
    permission,
    url: details.requestingUrl || pageUrl,
    mediaTypes: details.mediaTypes ?? [],
  };
}

/**
 * The ask in an Electron permission check. A check grants nothing by itself (capture still goes
 * through the request), and Chromium checks `media` as `unknown` before enumerating devices, so
 * only a camera check counts as video.
 */
export function permissionCheckAsk(
  permission: string,
  origin: string,
  details: { readonly mediaType?: string },
): PermissionAsk {
  return {
    permission,
    url: origin,
    mediaTypes: details.mediaType === "video" ? ["video"] : ["audio"],
  };
}

/**
 * Whether to grant a permission. Nothing is granted to a page outside `trustedOrigins`, and of
 * capture only the microphone, for dictation and voice: no camera, and no screen, which Electron
 * reports as `display-capture` rather than `media` since 45. Other permissions the app's own pages
 * ask for are granted, as Electron did before there was a handler (clipboard writes use one).
 * `microphone: false` refuses `media` outright, for a shell that carries nothing that listens.
 */
export function grantPermission(
  ask: PermissionAsk,
  trustedOrigins: ReadonlySet<string>,
  { microphone = true }: { readonly microphone?: boolean } = {},
): boolean {
  if (!isTrustedSenderUrl(ask.url, trustedOrigins)) return false;
  if (ask.permission === "display-capture") return false;
  if (ask.permission !== "media") return true;
  if (!microphone) return false;
  return ask.mediaTypes.length > 0 && ask.mediaTypes.every((type) => type === "audio");
}
