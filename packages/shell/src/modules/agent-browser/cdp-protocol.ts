/**
 * The DevTools Protocol answers and events the headless browser reads, as the protocol documents
 * them. Chrome is the other end of a pipe this app opened, so its messages are taken as typed here,
 * in one place, rather than at each use.
 */

/** A request the browser holds until it is continued, failed or fulfilled. */
export interface PausedRequest {
  readonly requestId: string;
  readonly request: { readonly url: string; readonly method: string };
  readonly frameId: string;
  readonly resourceType: string;
  readonly networkId?: string;
}

/** A frame that navigated. */
export interface FrameEvent {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly url: string;
    readonly urlFragment?: string;
  };
}

/** A page's back and forward list. */
export interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url?: string }>;
}

/** Each command the browser is sent whose answer is read, with that answer. */
export interface CdpResults {
  readonly "Target.createBrowserContext": { readonly browserContextId: string };
  readonly "Target.createTarget": { readonly targetId: string };
  readonly "Target.attachToTarget": { readonly sessionId: string };
  readonly "Target.getTargetInfo": { readonly targetInfo: { readonly title: string } };
  readonly "Page.getNavigationHistory": NavigationHistory;
  readonly "Page.navigate": { readonly errorText?: string };
  readonly "Page.getFrameTree": {
    readonly frameTree: { readonly frame: { readonly id: string; readonly url: string } };
  };
}

/** Each event the browser sends that is read, with its parameters. */
export interface CdpEvents {
  readonly "Fetch.requestPaused": PausedRequest;
  readonly "Target.attachedToTarget": {
    readonly sessionId: string;
    readonly waitingForDebugger?: boolean;
    readonly targetInfo: {
      readonly targetId: string;
      readonly type: string;
      readonly url?: string;
      readonly browserContextId?: string;
    };
  };
  readonly "Target.detachedFromTarget": { readonly sessionId?: string };
  readonly "Target.targetInfoChanged": {
    readonly targetInfo?: { readonly targetId?: string; readonly title?: string };
  };
  readonly "Target.targetDestroyed": { readonly targetId?: string };
  readonly "Page.frameNavigated": FrameEvent;
  readonly "Page.navigatedWithinDocument": { readonly frameId: string; readonly url: string };
  readonly "Page.frameStartedLoading": { readonly frameId: string };
  readonly "Page.frameStoppedLoading": { readonly frameId: string };
  readonly "Page.javascriptDialogOpening": { readonly type?: string };
  readonly "Page.screencastFrame": {
    readonly data: string;
    readonly sessionId: number;
    readonly metadata: { readonly deviceWidth: number; readonly deviceHeight: number };
  };
}

/** `answer` as the result the protocol documents for `method`. */
export const cdpResult = <M extends keyof CdpResults>(_method: M, answer: unknown): CdpResults[M] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Chrome answers each method with the result the DevTools Protocol documents for it
  answer as CdpResults[M];

/** `params` as the parameters the protocol documents for `event`. */
export const cdpEvent = <E extends keyof CdpEvents>(_event: E, params: unknown): CdpEvents[E] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Chrome sends each event with the parameters the DevTools Protocol documents for it
  params as CdpEvents[E];

/** Sends `method` and answers with the result the protocol documents for it. */
export const cdpSend = async <M extends keyof CdpResults>(
  connection: { send(method: string, params?: object, sessionId?: string): Promise<unknown> },
  method: M,
  params?: object,
  sessionId?: string,
): Promise<CdpResults[M]> => cdpResult(method, await connection.send(method, params, sessionId));
