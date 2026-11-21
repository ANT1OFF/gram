// The user's WebRTC switch for a thread's local page (`DesktopPreview.setWebRtc`): which page may
// have it, and the handler that makes the page again with it or without.
//
// It is offered only for a page the user opened by typing its address in the address strip, while
// the page is still on that address's origin: never for a page an agent opened (`show_panel`, the
// agent browser), a port chip's, a file preview, or any of Gram's own origins. Whatever then serves
// that origin has WebRTC, code any agent working in that folder writes and processes one left
// running included, so the renderer also ends it on a turn under way in any thread on that folder.

import type { WebContents } from "electron";

import { isPreviewFilesUrl, loopbackUrl } from "@gram/contracts/link-trust";

import { Channels } from "../../channels.ts";
import type { ShellIpc } from "../ipc.ts";

/** `url`'s origin, `undefined` for one that has none. */
export const originOf = (url: string): string | undefined => {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

/** What the switch asks of a thread's page. */
export interface WebRtcCandidate {
  readonly kind: "local" | "web";
  /** Where the page is now. */
  readonly url: string;
  /** The origin of the address the user typed for it, while nothing else opened or took it since. */
  readonly typedOrigin: string | undefined;
  /** Who drives it, once an agent has used it. */
  readonly driver: "agent" | "user" | undefined;
  /** Whether `url` is one of Gram's own pages: the app, its pages' or its file preview listener. */
  readonly appPage: (url: string) => boolean;
}

/** The origin the user's switch may give WebRTC to on `page`, or `undefined` where it is refused. */
export function webRtcOriginFor(page: WebRtcCandidate): string | undefined {
  if (page.kind !== "local" || page.driver === "agent") return undefined;
  if (loopbackUrl(page.url) === undefined || isPreviewFilesUrl(page.url) || page.appPage(page.url))
    return undefined;
  const origin = originOf(page.url);
  return origin !== undefined && origin === page.typedOrigin ? origin : undefined;
}

/**
 * `webRtcOriginFor` for the preview module's pages: Gram's own pages are its file preview
 * listener's, the origins the server named for the thread's agent, and the app's own (`appOrigins`).
 */
export const switchOriginOf =
  (
    agent:
      | {
          driverOf(threadId: string): "agent" | "user" | undefined;
          isAppPage?(threadId: string, url: string): boolean;
        }
      | undefined,
    appOrigins: (() => Iterable<string>) | undefined,
  ) =>
  (page: Omit<SwitchedPage, "webRtcOrigin">): string | undefined => {
    const contents = page.view.webContents;
    if (contents.isDestroyed()) return undefined;
    const own = new Set(appOrigins?.() ?? []);
    return webRtcOriginFor({
      kind: page.kind,
      url: contents.getURL(),
      typedOrigin: page.typedOrigin,
      driver: agent?.driverOf(page.threadId),
      appPage: (url) =>
        agent?.isAppPage?.(page.threadId, url) === true || own.has(originOf(url) ?? ""),
    });
  };

/** The preview module's page, as the switch's handler sees it. */
export interface SwitchedPage {
  readonly threadId: string;
  readonly kind: "local" | "web";
  readonly view: { readonly webContents: WebContents };
  readonly webRtcOrigin: string | undefined;
  typedOrigin: string | undefined;
}

/** What the switch's handler needs of the preview module. */
export interface WebRtcSwitchHost<P extends SwitchedPage> {
  readonly previewFor: (input: unknown, sender: WebContents) => P | undefined;
  /** Where the switch may go on for `page`, as `webRtcOriginFor` decides. */
  readonly originFor: (page: P) => string | undefined;
  /** `page` made again in the local session, with WebRTC for `origin` or with none. */
  readonly remake: (page: P, origin: string | undefined) => Promise<P>;
  readonly open: (page: P, url: string) => Promise<void>;
  readonly report: (page: P) => void;
}

/** Serves the user's switch: the page is made again, with WebRTC or without, at the same address. */
export function installWebRtcSwitch<P extends SwitchedPage>(
  ipc: ShellIpc,
  host: WebRtcSwitchHost<P>,
): void {
  ipc.handle(Channels.previewSetWebRtc, async (input, event) => {
    const preview = host.previewFor(input, event.sender);
    const allowed: unknown =
      typeof input === "object" && input !== null ? Reflect.get(input, "allowed") : undefined;
    if (preview?.kind !== "local" || typeof allowed !== "boolean") return false;
    if ((preview.webRtcOrigin !== undefined) === allowed) return true;
    // For the origin the page is on as the user switches it, and only where it is offered.
    const origin = allowed ? host.originFor(preview) : undefined;
    if (allowed && origin === undefined) return false;
    const url = preview.view.webContents.getURL();
    const next = await host.remake(preview, origin);
    next.typedOrigin = preview.typedOrigin;
    if (loopbackUrl(url) !== undefined) await host.open(next, url);
    host.report(next);
    return true;
  });
}
