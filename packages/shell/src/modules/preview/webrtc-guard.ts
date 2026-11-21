// WebRTC, taken away from every frame of a page: the preview's local session's pages and pinned
// pages (`modules/pages`). Chromium resolves an ICE server's or a remote candidate's host name
// through the system resolver before any of a session's controls (its request check, proxy and UDP
// policy) apply, so a page could otherwise send what it holds, or what the user types into it, out
// in DNS queries for names it chose. No setting of a session or a page turns that off, and a name
// rule for the resolver (as the agent's headless browser has, `agent-browser/headless.ts`) would
// hold for the whole app.
//
// A preload can't do it: it never runs in a child the page makes by script at `about:blank`, which
// shares the page's origin, so the page could reach a peer connection through it. So the page's
// own debugger session puts the removal in place: the protocol runs it first in every document of
// the page, `about:blank` children and their children included, and in each out-of-process frame,
// which starts paused until it has the removal too. It is in place before the page loads anything
// but `about:blank`; a page the guard couldn't reach loads nothing (`ready`).
//
// Anything else may share the session (the agent browser's pane drives the same page through it),
// and when something detaches it the guard attaches again at once and puts itself back: documents
// already open keep the removal, and a frame made in that moment is the one gap.

/** What a page's script reaches WebRTC by. */
export const WEBRTC_NAMES = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceTransport",
  "RTCDtlsTransport",
  "RTCSctpTransport",
  "RTCIceCandidate",
  "RTCSessionDescription",
] as const;

/** Run in each document before its own scripts. */
export const DROP_WEBRTC = `for (const name of ${JSON.stringify(WEBRTC_NAMES)}) Reflect.deleteProperty(globalThis, name);`;

/** What the guard needs of a page: Electron's `WebContents`, in part. */
export interface GuardedContents {
  isDestroyed(): boolean;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  readonly debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
    on(
      event: "message",
      listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void,
    ): unknown;
    on(event: "detach", listener: (event: unknown, reason: string) => void): unknown;
  };
}

interface AttachedTarget {
  readonly sessionId: string;
  readonly targetInfo: { readonly type: string };
}

const attachedTarget = (params: unknown): AttachedTarget | undefined => {
  if (typeof params !== "object" || params === null) return undefined;
  const sessionId: unknown = Reflect.get(params, "sessionId");
  const info: unknown = Reflect.get(params, "targetInfo");
  const type: unknown =
    typeof info === "object" && info !== null ? Reflect.get(info, "type") : undefined;
  return typeof sessionId === "string" && typeof type === "string"
    ? { sessionId, targetInfo: { type } }
    : undefined;
};

/**
 * Takes WebRTC away from every frame `contents` ever shows. Resolves `true` once the removal is in
 * place, and `false` when it couldn't be: the caller loads nothing in such a page.
 */
export async function guardWebRtc(
  contents: GuardedContents,
  warn: (fields: Readonly<Record<string, unknown>>, message: string) => void,
): Promise<boolean> {
  const cdp = contents.debugger;
  const install = (sessionId?: string) =>
    Promise.all([
      // The removal is only kept while the page domain is on.
      cdp.sendCommand("Page.enable", {}, sessionId),
      cdp.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: DROP_WEBRTC, runImmediately: true },
        sessionId,
      ),
      // Every out-of-process frame, its own children included, starts paused, for the above.
      cdp.sendCommand(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        sessionId,
      ),
    ]);
  cdp.on("message", (_event, method, params) => {
    if (method !== "Target.attachedToTarget") return;
    const target = attachedTarget(params);
    if (target === undefined) return;
    const { sessionId } = target;
    // A worker has no WebRTC; it only waits to be let go.
    const guarded = target.targetInfo.type === "iframe" ? install(sessionId) : Promise.resolve();
    void guarded
      .then(
        () => cdp.sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId),
        // A frame that can't take the removal stays paused, and runs nothing.
        (error: unknown) =>
          warn({ source: "webrtc-guard", error: String(error) }, "a frame wasn't guarded"),
      )
      .catch(() => {});
  });
  // A page being closed detaches again the moment it is attached: then the guard lets it go.
  let attaching = false;
  cdp.on("detach", () => {
    if (contents.isDestroyed() || attaching) return;
    attaching = true;
    try {
      cdp.attach("1.3");
    } catch (error) {
      warn({ source: "webrtc-guard", error: String(error) }, "the guard couldn't attach again");
      return;
    }
    install().then(
      () => (attaching = false),
      (error: unknown) => {
        if (contents.isDestroyed()) return;
        warn(
          { source: "webrtc-guard", error: String(error) },
          "the guard couldn't put itself back",
        );
      },
    );
  });
  try {
    // A page that never loaded anything has no renderer, and the protocol waits for one forever.
    if (contents.getURL() === "") await contents.loadURL("about:blank");
    if (!cdp.isAttached()) cdp.attach("1.3");
    await install();
    return true;
  } catch (error) {
    warn({ source: "webrtc-guard", error: String(error) }, "the page couldn't be guarded");
    return false;
  }
}
