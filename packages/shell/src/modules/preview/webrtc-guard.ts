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
  readonly id: number;
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

interface Held {
  readonly until: Promise<boolean>;
  readonly settle: (up: boolean) => void;
}

const held = new Map<number, Held>();

const hold = (id: number) => {
  if (held.has(id)) return;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  held.set(id, { until: promise, settle: resolve });
};
const release = (id: number) => {
  held.get(id)?.settle(true);
  held.delete(id);
};
const giveUp = (id: number) => {
  hold(id);
  held.get(id)?.settle(false);
};

/** Whether `contents` is guarded but its removal isn't in place right now. */
export const webRtcGuardDown = (contents: { readonly id: number }): boolean =>
  held.has(contents.id);

/**
 * For a guarded page whose removal isn't in place: settles `true` once it is, and `false` if it
 * won't be, so the session's request check holds every request of the page until then and lets
 * nothing load in a page given up. `undefined` for any other page.
 */
export const webRtcGuardHeld = (contents: { readonly id: number }): Promise<boolean> | undefined =>
  held.get(contents.id)?.until;

/**
 * `listener`, a session's request check, held for a page whose removal isn't in place: it runs
 * once the removal is back, and the request is refused if it won't be.
 */
export const heldForGuard =
  <Details extends { readonly webContents?: { readonly id: number } | undefined }>(
    listener: (details: Details, callback: (response: { cancel?: boolean }) => void) => void,
  ) =>
  (details: Details, callback: (response: { cancel?: boolean }) => void): void => {
    const until = details.webContents && webRtcGuardHeld(details.webContents);
    if (until === undefined) return listener(details, callback);
    void until.then((up) => (up ? listener(details, callback) : callback({ cancel: true })));
  };

const REATTACH_TRIES = 5;

const WORKERS = new Set(["worker", "service_worker", "shared_worker"]);

/**
 * Takes WebRTC away from every frame `contents` ever shows. Resolves `true` once the removal is in
 * place, and `false` when it couldn't be: the caller loads nothing in such a page.
 */
export async function guardWebRtc(
  contents: GuardedContents,
  warn: (fields: Readonly<Record<string, unknown>>, message: string) => void,
): Promise<boolean> {
  const cdp = contents.debugger;
  hold(contents.id);
  const install = (sessionId?: string) =>
    Promise.all([
      cdp.sendCommand("Page.enable", {}, sessionId),
      cdp.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: DROP_WEBRTC, runImmediately: true },
        sessionId,
      ),
      cdp
        .sendCommand("Page.setPrerenderingAllowed", { isAllowed: false }, sessionId)
        .catch(() => {}),
      cdp.sendCommand(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        sessionId,
      ),
    ]);
  const fail = (message: string, error?: unknown) => {
    giveUp(contents.id);
    if (contents.isDestroyed()) return;
    warn({ source: "webrtc-guard", error: String(error) }, message);
    void contents.loadURL("about:blank").catch(() => {});
  };
  cdp.on("message", (_event, method, params) => {
    if (method !== "Target.attachedToTarget") return;
    const target = attachedTarget(params);
    if (target === undefined) return;
    const { sessionId } = target;
    const guarded = WORKERS.has(target.targetInfo.type) ? Promise.resolve() : install(sessionId);
    void guarded
      .then(
        () => cdp.sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId),
        (error: unknown) =>
          warn({ source: "webrtc-guard", error: String(error) }, "a frame wasn't guarded"),
      )
      .catch(() => {});
  });
  let attaching = false;
  let detachedMeanwhile = false;
  let tries = 0;
  const attachAgain = () => {
    if (contents.isDestroyed()) return;
    if (attaching) {
      detachedMeanwhile = true;
      return;
    }
    if ((tries += 1) > REATTACH_TRIES) return fail("the page's debugger keeps detaching");
    attaching = true;
    detachedMeanwhile = false;
    try {
      if (!cdp.isAttached()) cdp.attach("1.3");
    } catch (error) {
      attaching = false;
      return fail("the guard couldn't attach again", error);
    }
    void install()
      .then(
        () => !detachedMeanwhile && cdp.isAttached(),
        () => false,
      )
      .then((back) => {
        attaching = false;
        if (back) {
          tries = 0;
          release(contents.id);
        } else attachAgain();
      });
  };
  cdp.on("detach", () => {
    hold(contents.id);
    setImmediate(attachAgain);
  });
  try {
    if (contents.getURL() === "") await contents.loadURL("about:blank");
    if (!cdp.isAttached()) cdp.attach("1.3");
    await install();
    release(contents.id);
    return true;
  } catch (error) {
    fail("the page couldn't be guarded", error);
    return false;
  }
}
