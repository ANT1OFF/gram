// Agents driving their thread's page in the Preview pane: the shell's end of the pane commands
// (contracts' `PaneRequest`), which the server sends over its `parentPort`. Every rule is held
// here, whatever the server asked:
// where the page may go and load from (`core/browse-rules.ts`), act limits, and one driver at a
// time. The preview module asks this one about an agent's page before each navigation and
// request, and tells it when the user puts input into the pane.

import { randomUUID } from "node:crypto";

import type { ResolvedHost, WebContents } from "electron";

import {
  BROWSE_REFUSED_BECAUSE,
  browseTarget,
  isPrivateAddress,
  PANE_ACTING_OPS,
  PANE_RECORDING_MAX_FRAMES,
  PANE_RECORDING_MAX_MS,
  type BrowserInspection,
  type BrowserRegion,
  type BrowserViewportPreset,
  type PaneAccess,
  type PaneLimits,
  type PaneBlocked,
  type PaneDriver,
  type PanePage,
  type PanePoint,
  type PaneRequest,
  type PaneResult,
} from "@gram/contracts/link-trust";

import {
  actRefusal,
  AGENT_INPUT_GRACE_MS,
  agentNavigation,
  agentRequest,
  isWrite,
  isUserInput,
  parsePaneRequest,
  submitNeedsConfirmation,
  type BrowseContext,
  type BrowseHostList,
} from "../../core/browse-rules.ts";
import type { ShellLog } from "../../core/log.ts";
import type { PreviewRequestDetails } from "../preview/main.ts";
import { gifParts, type GifFrame } from "../../core/gif.ts";
import {
  createPageDriver,
  PageAccessError,
  StalePageError,
  StaleRefError,
  UserControlError,
  type Cdp,
  type PageDriver,
  type PageTarget,
} from "../../core/page-driver.ts";

/** What the preview module gives this one: each thread's page, made when first asked for. */
export interface PaneViews {
  /** The thread's page, made (hidden until its tab shows it) when `create` and none is there. */
  contentsFor(threadId: string, create: boolean): WebContents | undefined;
}

export interface AgentPanesOptions {
  readonly hosts: BrowseHostList;
  readonly views: PaneViews;
  readonly log: ShellLog;
  /** Resolves a host's addresses through the pane's session, for the private-address check. */
  readonly resolveHost: (host: string) => Promise<ResolvedHost>;
  /** Tells the windows who drives a thread's page now, for the pane's header. */
  readonly driverChanged?: ((threadId: string, driver: PaneDriver) => void) | undefined;
  /**
   * A recording frame's JPEG as raw BGRA pixels: Electron's `nativeImage`. Without it this shell
   * doesn't record.
   */
  readonly decodeFrame?:
    | ((jpegBase64: string) => { width: number; height: number; pixels: Uint8Array } | undefined)
    | undefined;
}

export interface AgentPanes {
  /** Runs one pane request from the server; anything malformed is refused. */
  serve(raw: unknown, requestId?: string): Promise<PaneResult>;
  /** Withdraw a server request; further dispatch/output stops, already sent input is not undone. */
  cancel(requestId: string): void;
  /**
   * The preview module's question before a main-frame navigation of `contents`: `undefined`
   * when it isn't an agent's page, or the URL is one the preview's own rules decide (loopback, or
   * the user driving to a page that isn't approved), else whether it loads.
   */
  navigation(contents: WebContents, url: string): "load" | "block" | undefined;
  /**
   * The same for one request the page makes, for the session's `webRequest`. On an agent's page:
   * no main frame reaches loopback from a page or redirect elsewhere; a public page loads from
   * public hosts and nothing private; and off loopback nothing that writes goes out during an
   * agent's action without the user's card. `undefined` leaves the rest to the preview's rules.
   */
  request(
    contents: WebContents,
    details: PreviewRequestDetails,
  ): Promise<"allow" | "block"> | undefined;
  /** The user put input into `contents`: if it is an agent's page, the user drives it now. */
  userInput(contents: WebContents): void;
  /** The user hands the thread's page back to its agent. */
  handBack(threadId: string): void;
  takeOver(threadId: string): void;
  inspectionOf(threadId: string): BrowserInspection | undefined;
  inspect(threadId: string, target?: { ref?: string; region?: BrowserRegion }): Promise<PaneResult>;
  viewport(threadId: string, preset: BrowserViewportPreset): Promise<PaneResult>;
  /** Who drives the thread's page; `undefined` before its agent used it. */
  driverOf(threadId: string): PaneDriver | undefined;
  /** What the agent said its latest input on the thread's page does, and when. */
  actionOf(threadId: string): { readonly summary: string; readonly at: number } | undefined;
  /** Whether the agent is recording the thread's page. */
  recordingOf(threadId: string): boolean;
  /** The thread's page closed: its once-allowed hosts and its driver go with it. */
  closed(threadId: string): void;
}

interface AgentPage {
  readonly threadId: string;
  readonly contents: WebContents;
  readonly driver: PageDriver;
  driving: PaneDriver;
  /** A takeover and hand-back cannot revive input admitted under earlier ownership. */
  ownership: number;
  /** Only the currently serialized command can authorize protocol reads or mutations. */
  validateOperation: ((mutating: boolean) => void) | undefined;
  /** Until when input events in the view are the agent's own. */
  agentInputUntil: number;
  /** A navigation the page started that this module stopped, since the last command. */
  blocked: PaneBlocked | undefined;
  /** Counts the documents the page has shown, so a confirmation holds for the one it named. */
  document: number;
  /** The confirmation card the server is raising, until it answers or the page moves on. */
  pending: PendingConfirm | undefined;
  /** While an approved submission runs, the one URL it may send to; nothing else is let out. */
  armedFor: string | undefined;
  /** The writes the page sent during an agent's action, held until the user answers. */
  held: HeldWrites | undefined;
  /** What the agent said its latest input does, for the pane's header. */
  lastAction: { readonly summary: string; readonly at: number } | undefined;
  recording: Recording | undefined;
}

/** Frames of the page an agent is recording, kept until it stops. */
interface Recording {
  readonly frames: Array<{
    readonly at: number;
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array;
  }>;
  readonly scale: number;
  readonly startedAt: number;
  readonly timer: NodeJS.Timeout;
  /** A frame is being taken. */
  busy: boolean;
  /** The kept frames' pixel bytes, which `RECORDING_MAX_BYTES` caps. */
  bytes: number;
  /** Its frame or time budget ran out; what it has is kept. */
  full: boolean;
}

/** How often a recording takes a frame, at most; a capture can take longer. */
const FRAME_MS = 250;
/** The most pixel bytes a recording keeps before it stops taking frames. */
const RECORDING_MAX_BYTES = 200_000_000;
/** How long the last frame of a recording shows. */
const LAST_FRAME_MS = 1_000;

/**
 * Requests that write, which the page sent while an agent acted, paused in `webRequest` rather
 * than cancelled: the user's card releases them as sent, so approving never runs the agent's
 * input a second time. Any other command, a new document or `HELD_MS` cancels them.
 */
interface HeldWrites {
  readonly token: string;
  /** Shown on a card: the batch is closed, and a later write is cancelled, not added to it. */
  reported: boolean;
  readonly document: number;
  readonly urls: string[];
  readonly answer: Array<(release: boolean) => void>;
  readonly timer: NodeJS.Timeout;
}

/** A submission the shell asked the user about, good once for that document and target. */
interface PendingConfirm {
  readonly token: string;
  readonly document: number;
  /** The command it is for, without its token. */
  readonly key: string;
  readonly action: string;
  readonly control: string;
}

/** How long a page that started loading after an action is waited for. */
const SETTLE_MS = 10_000;
/** How long after an action a navigation it causes is looked for. */
const ACTION_SETTLE_MS = 300;
/** How long a held write waits for the user's card before it is cancelled. */
const HELD_MS = 10 * 60_000;
/** How many held writes a card's text names; every one is in its details. */
const HELD_SHOWN = 3;
/** The most writes one card holds; the page's further writes are cancelled. */
const HELD_MAX = 20;
/** How long a page's own GET navigation waits for the renderer to say whether it submits a form. */
const FORM_SIGNAL_MS = 150;

/** `url` without its fragment, which a request never carries. */
const withoutHash = (url: string) => {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
};

/** How often a settling action looks for a write it held. */
const HELD_POLL_MS = 100;

/** How many request ids' latest hop are kept, to judge where a redirect came from. */
const HOPS_KEPT = 512;

const fail = (
  code: Extract<PaneResult, { ok: false }>["code"],
  message: string,
  extra: Partial<Extract<PaneResult, { ok: false }>> = {},
): PaneResult => ({ ok: false, code, message, ...extra });

/**
 * The page's protocol session. Every event subscription shares one debugger listener, so the
 * driver's many subscriptions don't trip Node's listener-leak warning.
 */
const cdpOf = (contents: WebContents): Cdp => {
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const handler = (_event: unknown, method: string, params: unknown) => {
    for (const listener of Array.from(listeners.get(method) ?? [])) listener(params);
  };
  return {
    send: (method, params) => contents.debugger.sendCommand(method, params),
    on: (event, listener) => {
      if (listeners.size === 0) contents.debugger.on("message", handler);
      const forEvent = listeners.get(event) ?? new Set();
      forEvent.add(listener);
      listeners.set(event, forEvent);
      return () => {
        forEvent.delete(listener);
        if (forEvent.size === 0) listeners.delete(event);
        if (listeners.size === 0) contents.debugger.off("message", handler);
      };
    },
  };
};

const block = (): Promise<"block"> => Promise.resolve("block");

const LOCAL_ONLY =
  "That runs only on local pages (localhost, 127.0.0.1): a public page's code and responses aren't the agent's to read or run.";

const targetOf = (point: PanePoint): PageTarget =>
  point.ref !== undefined ? { ref: point.ref } : { coordinate: point.coordinate };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for `contents` to stop loading, if it is, for at most `SETTLE_MS`. */
const settled = (contents: WebContents, stop: () => boolean = () => false) =>
  new Promise<void>((resolve) => {
    if (contents.isDestroyed() || !contents.isLoading() || stop()) return resolve();
    const timer = setTimeout(done, SETTLE_MS);
    // A held main-frame write keeps the page loading until it is answered.
    const poll = setInterval(() => {
      if (stop()) done();
    }, HELD_POLL_MS);
    function done() {
      clearTimeout(timer);
      clearInterval(poll);
      if (!contents.isDestroyed()) contents.off("did-stop-loading", done);
      resolve();
    }
    contents.once("did-stop-loading", done);
  });

/** The recording as a GIF, encoded a frame at a time so the shell stays responsive. */
const encodeRecording = async (recording: Recording): Promise<string> => {
  const frames: GifFrame[] = recording.frames.map((frame, index) => ({
    width: frame.width,
    height: frame.height,
    pixels: frame.pixels,
    delayMs: (recording.frames[index + 1]?.at ?? frame.at + LAST_FRAME_MS) - frame.at,
  }));
  const parts: Uint8Array[] = [];
  for (const part of gifParts(frames, { order: "bgra" })) {
    parts.push(part);
    await new Promise<void>((done) => setImmediate(done));
  }
  return Buffer.concat(parts).toString("base64");
};

/** Serves pane commands for every thread's page. */
export function createAgentPanes(options: AgentPanesOptions): AgentPanes {
  const { hosts, views, log } = options;
  const pages = new Map<string, AgentPage>();
  const byContents = new WeakMap<WebContents, AgentPage>();
  /** Hosts the user allowed once, by thread, until its page closes. */
  const once = new Map<string, Set<string>>();
  /** Lookups in flight, shared by the requests that wait on them; each answer is used once. */
  const lookups = new Map<string, Promise<boolean>>();
  /** Each main-frame request's latest URL, by id, so its next redirect knows where it came from. */
  const hops = new Map<number, string>();
  const hop = (id: number, url: string) => {
    hops.delete(id);
    hops.set(id, url);
    if (hops.size > HOPS_KEPT) hops.delete(hops.keys().next().value!);
  };

  /** The app's own origins the server named on the thread's latest command. */
  const appOrigins = new Map<string, ReadonlySet<string>>();
  const contextOf = (threadId: string): BrowseContext => ({
    approved: new Set(hosts.hosts()),
    once: once.get(threadId) ?? new Set(),
    appOrigins: appOrigins.get(threadId),
  });

  /**
   * Whether `host` resolves to an address on a private network, asked again for every request:
   * the pane's session resolves it through the same resolver and cache the connection then uses,
   * so the answer isn't held past what DNS gave it. A failure resolves nothing, so the request
   * fails on its own.
   */
  const resolvesPrivate = (host: string): Promise<boolean> => {
    const inFlight = lookups.get(host);
    if (inFlight !== undefined) return inFlight;
    const answer = options
      .resolveHost(host)
      .then(
        (resolved) => resolved.endpoints.some((endpoint) => isPrivateAddress(endpoint.address)),
        () => false,
      )
      .finally(() => lookups.delete(host));
    lookups.set(host, answer);
    return answer;
  };

  /** How the page on screen is allowed; `undefined` when it no longer is (a host removed). */
  const accessOf = (page: AgentPage): PaneAccess | undefined => {
    const url = page.contents.getURL();
    if (url === "") return "loopback";
    const decision = agentNavigation(url, contextOf(page.threadId));
    return decision.kind === "allow" ? decision.access : undefined;
  };

  const pageOf = (page: AgentPage): PanePage | null => {
    const url = page.contents.getURL();
    if (url === "") return null;
    return {
      url,
      title: page.contents.getTitle(),
      access: accessOf(page) ?? "loopback",
      driver: page.driving,
    };
  };

  const setDriving = (page: AgentPage, driving: PaneDriver) => {
    if (page.driving === driving) return;
    page.driving = driving;
    page.ownership += 1;
    options.driverChanged?.(page.threadId, driving);
  };

  const open = async (threadId: string): Promise<AgentPage | undefined> => {
    const existing = pages.get(threadId);
    if (existing !== undefined && !existing.contents.isDestroyed()) return existing;
    const contents = views.contentsFor(threadId, true);
    if (contents === undefined) return undefined;
    // A page that never loaded anything has no renderer yet, and the protocol's first command
    // waits for one forever.
    if (contents.getURL() === "") await contents.loadURL("about:blank").catch(() => {});
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    // A page the agent may not read, such as a file preview the user opened here, logs nothing it
    // can read later: held from the moment its navigation starts until another page commits.
    const unreadable = (url: string) => {
      const decision = agentNavigation(url, contextOf(threadId));
      return decision.kind === "refuse" && decision.reason === "app";
    };
    let held: number | null = unreadable(contents.getURL()) ? 0 : null;
    let attached: PageDriver | undefined;
    const hold = (from: number | null) => {
      held = from;
      attached?.holdConsole(from);
    };
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      // Invalidate an awaited command as soon as a new document starts loading, even before
      // getURL/CDP report its commit. A submission approval cannot follow that navigation.
      const page = pages.get(threadId);
      if (page?.contents === contents) {
        page.document += 1;
        page.pending = undefined;
        answerHeld(page, false);
      }
      if (unreadable(event.url)) hold(Date.now());
    });
    contents.on("did-navigate", (_event, url) => {
      if (!unreadable(url)) hold(null);
    });
    // Held all through the attach, whatever pages come and go meanwhile, and released only if the
    // page it ends on may be read.
    const driver = await createPageDriver(
      cdpOf(contents),
      0,
      () => pages.get(threadId)?.driving === "agent",
      (mutating) => pages.get(threadId)?.validateOperation?.(mutating),
    );
    attached = driver;
    driver.holdConsole(held);
    const page: AgentPage = {
      threadId,
      contents,
      driver,
      driving: "agent",
      ownership: 0,
      validateOperation: undefined,
      agentInputUntil: 0,
      blocked: undefined,
      document: 0,
      pending: undefined,
      armedFor: undefined,
      held: undefined,
      lastAction: undefined,
      recording: undefined,
    };
    contents.on("did-navigate", () => {
      driver.reset();
      page.document += 1;
      page.pending = undefined;
      answerHeld(page, false);
    });
    contents.debugger.on("detach", () => {
      if (pages.get(threadId) === page) pages.delete(threadId);
      driver.dispose();
    });
    contents.once("destroyed", () => {
      answerHeld(page, false);
      endRecording(page);
      if (pages.get(threadId) !== page) return;
      pages.delete(threadId);
      once.delete(threadId);
      appOrigins.delete(threadId);
    });
    pages.set(threadId, page);
    byContents.set(contents, page);
    options.driverChanged?.(threadId, "agent");
    return page;
  };

  /** Stops taking frames; what was kept goes with it. */
  const endRecording = (page: AgentPage) => {
    if (page.recording === undefined) return;
    clearInterval(page.recording.timer);
    page.recording = undefined;
  };

  /** Takes one frame, if the page may be read now and the last one is done. */
  const takeFrame = async (page: AgentPage, recording: Recording) => {
    if (recording.busy || recording.full || page.recording !== recording) return;
    if (
      recording.frames.length >= PANE_RECORDING_MAX_FRAMES ||
      Date.now() - recording.startedAt >= PANE_RECORDING_MAX_MS
    ) {
      recording.full = true;
      clearInterval(recording.timer);
      return;
    }
    // A page the agent may not read, such as a file the user previews here, isn't recorded, and
    // neither is the page while the user drives it: what they type there isn't the agent's.
    if (page.contents.isDestroyed() || accessOf(page) === undefined || page.driving !== "agent")
      return;
    recording.busy = true;
    try {
      const decoded = options.decodeFrame?.(await page.driver.frame(recording.scale));
      if (decoded === undefined || page.recording !== recording || accessOf(page) === undefined)
        return;
      const last = recording.frames.at(-1);
      // An unchanged page lengthens the frame before rather than adding one.
      if (
        last !== undefined &&
        last.width === decoded.width &&
        last.height === decoded.height &&
        Buffer.from(last.pixels).equals(Buffer.from(decoded.pixels))
      )
        return;
      recording.frames.push({ at: Date.now(), ...decoded });
      recording.bytes += decoded.pixels.length;
      if (recording.bytes >= RECORDING_MAX_BYTES) {
        recording.full = true;
        clearInterval(recording.timer);
      }
    } catch {
      // A frame the page changed under, or one taken while access lapsed, is skipped.
    } finally {
      recording.busy = false;
    }
  };

  const bindNavigationResult = (
    page: AgentPage,
    validate: () => void,
    deliver?: (validate: () => void) => void,
  ) => {
    // Navigation may change its admitted document; its returned metadata belongs to the
    // document reached here and still needs live authorization at result delivery.
    const document = page.document;
    const documentId = page.driver.inspection().documentId;
    const reached = page.contents.getURL();
    const validateResult = () => {
      validate();
      if (accessOf(page) === undefined)
        throw new PageAccessError("The navigation's page is no longer authorized.");
      if (
        page.document !== document ||
        page.driver.inspection().documentId !== documentId ||
        page.contents.getURL() !== reached
      )
        throw new StalePageError("The navigation's result document changed.");
    };
    validateResult();
    deliver?.(validateResult);
  };

  /** Loads `url` for the agent, after every check the navigation guard makes too. */
  const navigate = async (
    page: AgentPage,
    url: string,
    validate: () => void,
    deliver?: (validate: () => void) => void,
  ): Promise<PaneResult> => {
    const decision = agentNavigation(url, contextOf(page.threadId));
    if (decision.kind === "refuse") {
      return fail("refused", BROWSE_REFUSED_BECAUSE[decision.reason], {
        reason: decision.reason,
        host: decision.host,
      });
    }
    if (decision.kind === "ask") {
      return fail("needsApproval", `Browsing ${decision.host} needs the user's approval.`, {
        host: decision.host,
      });
    }
    const target = browseTarget(decision.url);
    if (target.kind === "public" && (await resolvesPrivate(target.host))) {
      return fail("refused", BROWSE_REFUSED_BECAUSE.private, {
        reason: "private",
        host: target.host,
      });
    }
    page.blocked = undefined;
    // A page that won't load rejects here and shows its own error page; a redirect this module
    // stopped is reported below.
    validate();
    // Host consent may have been withdrawn while the address lookup was awaited.
    if (agentNavigation(url, contextOf(page.threadId)).kind !== "allow")
      throw new PageAccessError("The navigation is no longer authorized.");
    await page.contents.loadURL(decision.url).catch(() => {});
    await settled(page.contents);
    bindNavigationResult(page, validate, deliver);
    const blocked = page.blocked as PaneBlocked | undefined;
    if (blocked !== undefined) {
      page.blocked = undefined;
      return blocked.reason === undefined
        ? fail("needsApproval", `The page redirected to ${blocked.host}, which needs approval.`, {
            host: blocked.host,
            page: pageOf(page),
          })
        : fail("refused", BROWSE_REFUSED_BECAUSE[blocked.reason], {
            reason: blocked.reason,
            host: blocked.host,
            page: pageOf(page),
          });
    }
    return { ok: true, page: pageOf(page) };
  };

  /** Runs an agent's input, so the view's input events for it don't read as the user's. */
  const asAgent = async <T>(page: AgentPage, act: () => Promise<T>): Promise<T> => {
    page.agentInputUntil = Number.POSITIVE_INFINITY;
    try {
      return await act();
    } finally {
      page.agentInputUntil = Date.now() + AGENT_INPUT_GRACE_MS;
    }
  };

  /** Releases the page's held writes as sent, or cancels them. */
  const answerHeld = (page: AgentPage, release: boolean) => {
    const held = page.held;
    if (held === undefined) return;
    page.held = undefined;
    clearTimeout(held.timer);
    for (const answer of held.answer) answer(release);
  };

  /**
   * Holds one write until the user's card answers; the request waits on what this returns. A
   * released write still goes out only if its host doesn't resolve to a private address, checked
   * when it is released, as every public request is.
   */
  const hold = (page: AgentPage, url: string, host: string): Promise<"allow" | "block"> =>
    new Promise((settle) => {
      if (page.held?.reported === true) return settle("block");
      page.held ??= {
        token: randomUUID(),
        reported: false,
        document: page.document,
        urls: [],
        answer: [],
        timer: setTimeout(() => answerHeld(page, false), HELD_MS),
      };
      // A card lists every request it releases; past a cap the page's writes are refused outright.
      if (page.held.urls.length >= HELD_MAX) return settle("block");
      page.held.urls.push(url);
      page.held.answer.push((release) => {
        if (!release) return settle("block");
        void resolvesPrivate(host).then((hidden) => settle(hidden ? "block" : "allow"));
      });
    });

  /** Asks the user, through the server's card, about a submission on this document and target. */
  const askToConfirm = (
    page: AgentPage,
    key: string,
    submission: { readonly action: string; readonly control: string },
    message: string,
  ): PaneResult => {
    const token = randomUUID();
    page.pending = { token, document: page.document, key, ...submission };
    return fail("needsConfirmation", message, {
      confirm: { ...submission, token },
      page: pageOf(page),
    });
  };

  /**
   * The approved submission `token` names, taken once: only for the document it was asked on and
   * the same command; anything else is no approval at all.
   */
  const approved = (
    page: AgentPage,
    key: string,
    token: string | undefined,
  ): PendingConfirm | undefined => {
    const pending = page.pending;
    if (token === undefined || pending === undefined || pending.token !== token) return undefined;
    page.pending = undefined;
    return pending.document === page.document && pending.key === key ? pending : undefined;
  };

  /**
   * Runs an action, then waits for what it loaded. A write the page sent during it without an
   * approval is held and asks the user, whose card releases it without running the action again;
   * a navigation it started to a host not approved is reported.
   */
  const act = async (
    page: AgentPage,
    armedFor: string | undefined,
    action: () => Promise<void>,
    completed?: () => void,
  ): Promise<PaneResult> => {
    page.blocked = undefined;
    page.armedFor = armedFor === undefined ? undefined : withoutHash(armedFor);
    try {
      await asAgent(page, action);
      await delay(ACTION_SETTLE_MS);
      await settled(page.contents, () => page.held !== undefined);
    } finally {
      page.armedFor = undefined;
    }
    completed?.();
    return reportAfter(page);
  };

  /** What an action came to: its held writes asked about, else the page and any navigation stopped. */
  const reportAfter = (page: AgentPage): PaneResult => {
    const { blocked, held } = page;
    page.blocked = undefined;
    if (held !== undefined) {
      held.reported = true;
      const requests = [...held.urls];
      const shown = requests.slice(0, HELD_SHOWN);
      const more = requests.length - shown.length;
      return fail(
        "needsConfirmation",
        "The page sent something off loopback; it waits until the user approves.",
        {
          confirm: {
            action: `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
            control:
              held.urls.length === 1
                ? "a request the page sent"
                : `${held.urls.length} requests the page sent`,
            token: held.token,
            requests,
          },
          page: pageOf(page),
        },
      );
    }
    return { ok: true, page: pageOf(page), ...(blocked === undefined ? {} : { blocked }) };
  };

  /** Bind a command to the document and live authorization it actually inspected. */
  const onDocument = async (
    page: AgentPage,
    limits: PaneLimits,
    deliver: ((validate: () => void) => void) | undefined,
    run: () => Promise<PaneResult>,
    signal?: AbortSignal,
  ): Promise<PaneResult> => {
    const document = page.document;
    const documentId = page.driver.inspection().documentId;
    const url = page.contents.getURL();
    const ownership = page.ownership;
    const validate = (mutating: boolean) => {
      if (signal?.aborted) throw new PageAccessError("The caller cancelled this command.");
      if (pages.get(page.threadId) !== page || page.contents.isDestroyed())
        throw new PageAccessError("The page is no longer available.");
      const access = accessOf(page);
      if (access === undefined) throw new PageAccessError("The page is no longer authorized.");
      if (
        document !== page.document ||
        documentId !== page.driver.inspection().documentId ||
        url !== page.contents.getURL()
      )
        throw new StalePageError("The page changed during the command; take a new snapshot.");
      if (mutating) {
        if (page.driving !== "agent" || ownership !== page.ownership)
          throw new UserControlError("The user took control.");
        if (actRefusal(access, limits) !== undefined)
          throw new PageAccessError("The current action limits no longer allow input here.");
      }
    };
    page.validateOperation = validate;
    const abort = () => {
      page.pending = undefined;
      page.armedFor = undefined;
      answerHeld(page, false);
    };
    signal?.addEventListener("abort", abort, { once: true });
    deliver?.(() => validate(false));
    try {
      const result = await run();
      validate(false);
      return result;
    } finally {
      page.validateOperation = undefined;
      signal?.removeEventListener("abort", abort);
    }
  };

  const run = async (
    request: PaneRequest,
    deliver?: (validate: () => void) => void,
    signal?: AbortSignal,
    validateNavigationAdmission?: () => void,
  ): Promise<PaneResult> => {
    const { threadId, command, limits } = request;
    appOrigins.set(threadId, new Set(limits.appOrigins ?? []));
    if (command.op === "grant") {
      if (command.scope === "always") {
        if (!hosts.add(command.host)) return fail("refused", `${command.host} can't be approved.`);
      } else {
        if (browseTarget(`https://${command.host}/`).kind !== "public") {
          return fail("refused", `${command.host} can't be approved.`);
        }
        once.set(threadId, (once.get(threadId) ?? new Set()).add(command.host));
      }
      return { ok: true, page: null };
    }
    const reads = command.op !== "navigate" && command.op !== "back";
    const known = pages.get(threadId);
    const page = reads ? known : await open(threadId);
    if (page === undefined || page.contents.isDestroyed()) {
      return reads
        ? fail("noPage", "Nothing is open in this thread's Preview pane yet; use browser_navigate.")
        : fail("noPane", "This window has no Preview pane to browse in.");
    }
    validateNavigationAdmission?.();
    const acting = !reads || PANE_ACTING_OPS.has(command.op) || command.op === "viewport";
    if (acting && page.driving === "user") {
      return fail(
        "userHasControl",
        "The user has control of the Preview pane. Wait until they hand it back to you.",
        { page: pageOf(page) },
      );
    }
    const ownership = page.ownership;
    const validateNavigation = () => {
      if (signal?.aborted || pages.get(threadId) !== page || page.contents.isDestroyed())
        throw new PageAccessError("The navigation was cancelled or its page closed.");
      validateNavigationAdmission?.();
      if (page.driving !== "agent" || ownership !== page.ownership)
        throw new UserControlError("The user took control.");
    };
    if (command.op === "navigate") return navigate(page, command.url, validateNavigation, deliver);
    if (command.op === "back") {
      const history = page.contents.navigationHistory;
      if (!history.canGoBack()) return fail("failed", "There is no page to go back to.");
      return act(
        page,
        undefined,
        async () => {
          validateNavigation();
          history.goBack();
        },
        () => bindNavigationResult(page, validateNavigation, deliver),
      );
    }
    if (page.contents.getURL() === "") {
      return fail(
        "noPage",
        "Nothing is open in this thread's Preview pane yet; use browser_navigate.",
      );
    }
    const access = accessOf(page);
    if (access === undefined) {
      const decision = agentNavigation(page.contents.getURL(), contextOf(threadId));
      if (decision.kind === "refuse") {
        return fail("refused", BROWSE_REFUSED_BECAUSE[decision.reason], {
          reason: decision.reason,
        });
      }
      const host = browseTarget(page.contents.getURL());
      return fail(
        "needsApproval",
        "The page's host is no longer approved.",
        host.kind === "public" ? { host: host.host } : {},
      );
    }
    const { driver } = page;
    /**
     * Whether the document is a local page's own: on loopback, not a blank page, whose origin a
     * public page that opened it would lend it, and with a loopback or opaque origin itself.
     */
    const localDocument = async () => {
      const url = page.contents.getURL();
      if (access !== "loopback" || url === "about:blank" || browseTarget(url).kind !== "loopback")
        return false;
      const origin = await driver.securityOrigin();
      return origin === "null" || browseTarget(origin).kind === "loopback";
    };
    const onPage = async (): Promise<PaneResult> => {
      switch (command.op) {
        case "snapshot":
          return {
            ok: true,
            page: pageOf(page),
            content: await driver.snapshot({
              interactive: command.filter === "interactive",
              depth: command.depth,
              ref: command.ref,
              maxChars: command.maxChars,
            }),
          };
        case "find":
          return { ok: true, page: pageOf(page), content: await driver.find(command.query) };
        case "text":
          return { ok: true, page: pageOf(page), content: await driver.text(command.maxChars) };
        case "screenshot":
          return {
            ok: true,
            page: pageOf(page),
            image: await driver.screenshot({
              ...(command.ref === undefined ? {} : { ref: command.ref }),
              ...(command.region === undefined ? {} : { region: command.region }),
              ...(command.scale === undefined ? {} : { scale: command.scale }),
              ...(command.format === undefined ? {} : { format: command.format }),
            }),
            inspection: driver.inspection(),
          };
        case "wait": {
          const shown = await driver.waitFor(command.ms, {
            ...(command.text === undefined ? {} : { text: command.text }),
            ...(command.ref === undefined ? {} : { ref: command.ref }),
          });
          // The driver's own answer, not page text.
          return { ok: true, page: pageOf(page), content: shown ? "shown" : "not shown" };
        }
        case "diagnostics":
          return { ok: true, page: pageOf(page), inspection: driver.inspection(true) };
        case "viewport":
          // Resize is a mutation and observes the same ownership/autonomy restrictions.
          if (actRefusal(access, limits) !== undefined)
            return fail(
              "loopbackOnly",
              "Viewport changes at this autonomy are limited to local pages.",
            );
          await driver.viewport({
            preset: command.preset,
            size: command.size,
            mobile: command.mobile,
            colorScheme: command.colorScheme,
          });
          return { ok: true, page: pageOf(page), inspection: driver.inspection() };
        case "console":
          return {
            ok: true,
            page: pageOf(page),
            console: driver.console(command.onlyErrors === true),
          };
        // Reading a page's own requests and running code in it are for local pages only: a
        // public page's responses may carry the user's data, and its code is someone else's.
        case "network":
          if (!(await localDocument())) return fail("refused", LOCAL_ONLY, { page: pageOf(page) });
          return {
            ok: true,
            page: pageOf(page),
            content:
              command.requestId === undefined
                ? driver.network(command.filter)
                : await driver.responseBody(command.requestId),
          };
        case "evaluate":
          if (!(await localDocument())) return fail("refused", LOCAL_ONLY, { page: pageOf(page) });
          break;
        case "recordStart": {
          if (options.decodeFrame === undefined)
            return fail("refused", "This shell can't record the page.");
          if (page.recording !== undefined)
            return fail("failed", "The page is already being recorded; stop it first.");
          const recording: Recording = {
            frames: [],
            scale: command.scale ?? 0.5,
            startedAt: Date.now(),
            timer: setInterval(() => void takeFrame(page, recording), FRAME_MS),
            busy: false,
            bytes: 0,
            full: false,
          };
          page.recording = recording;
          await takeFrame(page, recording);
          options.driverChanged?.(threadId, page.driving);
          return { ok: true, page: pageOf(page) };
        }
        case "recordStop": {
          const recording = page.recording;
          if (recording === undefined)
            return fail("failed", "Nothing is being recorded; start with browser_record.");
          clearInterval(recording.timer);
          for (let waited = 0; recording.busy && waited < 5_000; waited += 25) await delay(25);
          endRecording(page);
          options.driverChanged?.(threadId, page.driving);
          if (command.discard === true) return { ok: true, page: pageOf(page) };
          if (recording.frames.length === 0)
            return fail("failed", "The recording has no frames: the page couldn't be read.");
          const seconds = ((recording.frames.at(-1)!.at - recording.startedAt) / 1000).toFixed(1);
          return {
            ok: true,
            page: pageOf(page),
            content: `${recording.frames.length} frames over ${seconds} s${recording.full ? `, stopped at its limit of ${PANE_RECORDING_MAX_FRAMES} frames, ${PANE_RECORDING_MAX_MS / 1000} s or its memory budget` : ""}.`,
            file: { data: await encodeRecording(recording), mimeType: "image/gif" },
          };
        }
        default:
          break;
      }
      if (actRefusal(access, limits) !== undefined) {
        return fail(
          "loopbackOnly",
          "At this workspace's autonomy you act only on local pages (localhost); this one is public. Read it, or ask the user.",
          { page: pageOf(page) },
        );
      }
      const { confirmToken, ...unsigned } = command as typeof command & {
        readonly confirmToken?: string;
      };
      const held = page.held;
      // The user approved what the page sent: it goes out as it was, and the input isn't repeated.
      if (held !== undefined && confirmToken === held.token && held.document === page.document) {
        answerHeld(page, true);
        await delay(ACTION_SETTLE_MS);
        await settled(page.contents, () => page.held !== undefined);
        return reportAfter(page);
      }
      answerHeld(page, false);
      const key = JSON.stringify(unsigned);
      const grant = approved(page, key, confirmToken);
      // An approval that no longer holds (the page moved on, the wait ran out, another command came
      // between) approves nothing, and the input it was for isn't run on its strength.
      if (confirmToken !== undefined && grant === undefined) {
        return fail(
          "failed",
          "That approval no longer holds: the page changed or the wait ran out. Take a new snapshot and try again.",
          { page: pageOf(page) },
        );
      }
      // What a card approved is what runs: a submission that changed since is asked about again.
      const covers = (submission: { readonly action: string; readonly control: string }) =>
        grant !== undefined &&
        grant.action === submission.action &&
        grant.control === submission.control;
      // The user follows along: the pane's header says what this input is for as it runs.
      const summary = (command as { readonly actionSummary?: string }).actionSummary;
      if (summary !== undefined) {
        page.lastAction = { summary, at: Date.now() };
        options.driverChanged?.(threadId, page.driving);
      }
      switch (command.op) {
        case "evaluate": {
          let value = "";
          const result = await act(page, undefined, async () => {
            value = await driver.evaluate(command.expression);
          });
          return result.ok ? { ...result, content: value } : result;
        }
        case "click": {
          const target =
            command.ref === undefined
              ? command.coordinate === undefined
                ? undefined
                : { coordinate: command.coordinate }
              : { ref: command.ref };
          if (target === undefined) return fail("failed", "Name a ref or a coordinate to click.");
          // A right click opens a menu; it submits nothing.
          const submits =
            command.button === "right" ? undefined : await driver.clickSubmits(target);
          // One approval is for one submission, which a double click would send twice.
          if (submits !== undefined && command.double === true && access !== "loopback") {
            return fail(
              "failed",
              "A double click there would submit a form twice; click it once instead.",
              { page: pageOf(page) },
            );
          }
          if (submits !== undefined && submitNeedsConfirmation(access, covers(submits))) {
            return askToConfirm(page, key, submits, "That click submits a form.");
          }
          return act(page, submits === undefined ? undefined : grant?.action, () =>
            driver.click(target, {
              button: command.button ?? "left",
              double: command.double === true,
            }),
          );
        }
        case "type": {
          if (command.submit === true) {
            const submits = (await driver.enterSubmits(command.ref)) ?? {
              action: page.contents.getURL(),
              control: "Enter",
            };
            if (submitNeedsConfirmation(access, covers(submits))) {
              return askToConfirm(page, key, submits, "Pressing Enter there may submit a form.");
            }
          }
          return act(page, command.submit === true ? grant?.action : undefined, () =>
            driver.type(command.text, command.ref, command.submit === true),
          );
        }
        case "formInput":
          return act(page, undefined, () => driver.formInput(command.ref, command.value));
        case "pressKey": {
          const press = () =>
            driver.pressKey(command.ref, command.key, {
              ...(command.modifiers === undefined ? {} : { modifiers: command.modifiers }),
              ...(command.repeat === undefined ? {} : { repeat: command.repeat }),
            });
          // Enter in a field or on a submit control, and Space on one, submit its form; Enter
          // anywhere else may, as `type`'s submit does.
          const submits =
            (await driver.keySubmits(command.ref, command.key)) ??
            (command.key === "Enter"
              ? { action: page.contents.getURL(), control: "Enter" }
              : undefined);
          if (submits === undefined) return act(page, undefined, press);
          if ((command.repeat ?? 1) > 1 && access !== "loopback") {
            return fail(
              "failed",
              "A key that may submit a form off this computer is pressed once at a time.",
              { page: pageOf(page) },
            );
          }
          if (submitNeedsConfirmation(access, covers(submits))) {
            return askToConfirm(page, key, submits, "That key may submit a form.");
          }
          return act(page, grant?.action, press);
        }
        case "hover":
          return act(page, undefined, () => driver.hover(targetOf(command as PanePoint)));
        case "scroll":
          return act(page, undefined, () =>
            driver.scroll(
              command.ref === undefined && command.coordinate === undefined
                ? undefined
                : targetOf(command as PanePoint),
              command.direction,
              command.amount ?? 3,
            ),
          );
        case "scrollTo":
          return act(page, undefined, () => driver.scrollTo(command.ref));
        case "drag":
          return act(page, undefined, () =>
            driver.drag(targetOf(command.from), targetOf(command.to)),
          );
      }
      return fail("failed", "The pane couldn't read that command.");
    };
    return onDocument(page, limits, deliver, onPage, signal);
  };

  const queues = new Map<string, Promise<unknown>>();
  const queued = async <T>(threadId: string, task: () => Promise<T>): Promise<T> => {
    const before = queues.get(threadId) ?? Promise.resolve();
    const next = before.catch(() => {}).then(task);
    queues.set(threadId, next);
    try {
      return await next;
    } finally {
      if (queues.get(threadId) === next) queues.delete(threadId);
    }
  };
  // Notification callbacks and the awaited queue can also run after capture completion.
  // Withhold all output on revocation, and stale data/cards on document change.
  const deliverResult = (
    threadId: string,
    result: PaneResult,
    validate?: () => void,
  ): PaneResult => {
    const page = pages.get(threadId);
    if (validate !== undefined && (page === undefined || accessOf(page) === undefined))
      return fail("refused", "The page is no longer authorized; command output withheld.");
    if (validate !== undefined) {
      try {
        validate();
      } catch {
        // An already dispatched action retains its original document identity. Captures, read
        // content and confirmation cards from a stale command are never delivered.
        const observed = result.inspection;
        return fail(
          "staleRef",
          "Page changed; command output withheld. Take a new snapshot.",
          observed?.action === undefined
            ? {}
            : {
                inspection: {
                  capabilities: observed.capabilities,
                  documentId: observed.documentId,
                  action: observed.action,
                },
              },
        );
      }
    }
    return result;
  };
  const uiRead = async (threadId: string, command: PaneRequest["command"]): Promise<PaneResult> => {
    if (!pages.has(threadId))
      return fail("noPane", "Inspection unavailable: this page has no attached browser driver.");
    let validateDelivery: (() => void) | undefined;
    const delivered = await queued(threadId, async () => {
      const result = await (async () => {
        const completed = await run(
          {
            threadId,
            command,
            limits: { actOnLoopbackOnly: true, appOrigins: [...(appOrigins.get(threadId) ?? [])] },
          },
          (validate) => {
            validateDelivery = validate;
          },
        );
        validateDelivery?.();
        return completed;
      })().catch(() => fail("failed", "Inspection failed; capture unavailable."));
      const page = pages.get(threadId);
      options.driverChanged?.(threadId, page?.driving ?? "agent");
      return deliverResult(threadId, result, validateDelivery);
    });
    return deliverResult(threadId, delivered, validateDelivery);
  };
  const requests = new Map<string, AbortController>();
  return {
    cancel: (requestId) => requests.get(requestId)?.abort(),
    serve: async (raw, requestId) => {
      const request = parsePaneRequest(raw);
      if (request === undefined) return fail("failed", "The pane couldn't read that command.");
      if (requestId !== undefined && requests.has(requestId))
        return fail("failed", "Duplicate pane request.");
      const controller = new AbortController();
      if (requestId !== undefined) requests.set(requestId, controller);
      // Bind target/ownership at admission, including navigation. Only document commands also
      // bind the current document: navigation is allowed to replace it under the same ownership.
      const admitted = pages.get(request.threadId);
      const document = admitted?.document;
      const documentId = admitted?.driver.inspection().documentId;
      const url = admitted?.contents.getURL();
      const ownership = admitted?.ownership;
      const documentCommand = request.command.op !== "navigate" && request.command.op !== "grant";
      const validateAdmission = () => {
        if (controller.signal.aborted)
          throw new PageAccessError("The caller cancelled this command.");
        if (request.command.op === "grant") return;
        const current = pages.get(request.threadId);
        if (current !== admitted) throw new StalePageError("The queued command's page changed.");
        if (current?.ownership !== ownership)
          throw new UserControlError("Ownership changed while this command was queued.");
        if (!documentCommand) return;
        if (
          current?.document !== document ||
          current?.driver.inspection().documentId !== documentId ||
          current?.contents.getURL() !== url
        )
          throw new StalePageError("The queued command's document changed.");
      };
      let validateDelivery: (() => void) | undefined;
      const delivered = await queued(request.threadId, async () => {
        const previous = pages.get(request.threadId)?.driver.inspection().action?.id;
        let result: PaneResult;
        try {
          validateAdmission();
          result = await run(
            request,
            (validate) => {
              validateDelivery = validate;
            },
            controller.signal,
            request.command.op === "navigate" && admitted !== undefined
              ? validateAdmission
              : undefined,
          );
          validateDelivery?.();
        } catch (error) {
          log.warn({ source: "agent-browser", op: request.command.op }, "a pane command failed");
          result = fail(
            error instanceof UserControlError
              ? "userHasControl"
              : error instanceof PageAccessError
                ? "refused"
                : error instanceof StaleRefError
                  ? "staleRef"
                  : "failed",
            error instanceof UserControlError
              ? "The user took control; further agent input stopped."
              : error instanceof PageAccessError
                ? "The page is no longer authorized; command output withheld."
                : error instanceof StaleRefError
                  ? "Page or target changed; take a new snapshot."
                  : "The pane command failed; its effect may be unknown.",
          );
        }
        const page = pages.get(request.threadId);
        const inspection =
          page !== undefined && accessOf(page) !== undefined ? page.driver.inspection() : undefined;
        // Never attach an earlier action as evidence for a refused/new command.
        const freshAction = inspection?.action?.id !== previous;
        if (inspection !== undefined)
          result = {
            ...result,
            inspection: {
              ...result.inspection,
              capabilities: inspection.capabilities,
              documentId: inspection.documentId,
              viewportPreset: inspection.viewportPreset,
              capture: result.ok && result.image !== undefined ? inspection.capture : undefined,
              action: freshAction ? inspection.action : undefined,
            },
          };
        options.driverChanged?.(request.threadId, page?.driving ?? "agent");
        return deliverResult(request.threadId, result, validateDelivery);
      }).finally(() => {
        if (requestId !== undefined) requests.delete(requestId);
      });
      if (controller.signal.aborted)
        return fail("refused", "The caller cancelled this command; output withheld.");
      return deliverResult(request.threadId, delivered, validateDelivery);
    },
    navigation: (contents, url) => {
      const page = byContents.get(contents);
      if (page === undefined) return undefined;
      const decision = agentNavigation(url, contextOf(page.threadId));
      if (decision.kind === "allow") return decision.access === "loopback" ? undefined : "load";
      // The user drives: the preview's own rule sends the link to their browser, where a sign-in
      // or an EXAMPLE page opens with their device and identity.
      if (page.driving === "user") return undefined;
      page.blocked = {
        url,
        host: decision.host ?? url,
        ...(decision.kind === "refuse" ? { reason: decision.reason } : {}),
      };
      return "block";
    },
    request: (contents, details) => {
      const page = byContents.get(contents);
      if (page === undefined) return undefined;
      const before = details.mainFrame ? hops.get(details.id) : undefined;
      if (details.mainFrame) hop(details.id, details.url);
      const judge = (formSubmission: boolean) =>
        agentRequest(
          {
            url: details.url,
            method: details.method,
            mainFrame: details.mainFrame,
            initiator: details.initiator,
            before,
            page: contents.getURL(),
            // The user sends what they mean to; an approved submission sends to its own target.
            mayWrite:
              page.driving === "user" ||
              (page.armedFor !== undefined && withoutHash(details.url) === page.armedFor),
            formSubmission,
          },
          contextOf(page.threadId),
        );
      const answer = (
        verdict: ReturnType<typeof judge>,
      ): Promise<"allow" | "block"> | undefined => {
        switch (verdict.kind) {
          case "defer":
            return undefined;
          case "allow":
            return Promise.resolve("allow");
          case "resolve":
            return resolvesPrivate(verdict.host).then((hidden) => (hidden ? "block" : "allow"));
          case "block":
            if (verdict.navigation !== undefined) {
              page.blocked ??= { url: details.url, ...verdict.navigation };
            }
            return block();
          case "hold":
            return hold(page, details.url, verdict.host);
        }
      };
      // A page's own GET to a public page may be a form it submitted, which only the renderer
      // says, over the protocol, and not always before the request gets here: wait a moment for it.
      // A frame on any port or scheme counts: only the page around it has to be public.
      const pageAsked =
        !isWrite(details.method) &&
        details.initiator !== undefined &&
        page.driving === "agent" &&
        ((details.mainFrame && browseTarget(details.url).kind === "public") ||
          (details.subFrame && browseTarget(contents.getURL()).kind === "public"));
      if (!pageAsked) return answer(judge(false));
      const deadline = Date.now() + FORM_SIGNAL_MS;
      const waitForSignal = async (): Promise<"allow" | "block"> => {
        while (!page.driver.formSubmission(details.url) && Date.now() < deadline) {
          await delay(HELD_POLL_MS / 4);
        }
        return answer(judge(page.driver.formSubmission(details.url))) ?? "block";
      };
      return waitForSignal();
    },
    userInput: (contents) => {
      const page = byContents.get(contents);
      if (page === undefined || !isUserInput(Date.now(), page.agentInputUntil)) return;
      setDriving(page, "user");
    },
    handBack: (threadId) => {
      const page = pages.get(threadId);
      if (page !== undefined) setDriving(page, "agent");
    },
    takeOver: (threadId) => {
      const page = pages.get(threadId);
      if (page !== undefined) {
        page.pending = undefined;
        answerHeld(page, false);
        setDriving(page, "user");
      }
    },
    inspectionOf: (threadId) => {
      const page = pages.get(threadId);
      return page === undefined || accessOf(page) === undefined
        ? undefined
        : page.driver.inspection();
    },
    inspect: async (threadId, target) => {
      const result = await uiRead(threadId, { op: "screenshot", ...target });
      if (!result.ok) return result;
      const page = pages.get(threadId);
      return page === undefined ||
        accessOf(page) === undefined ||
        result.inspection?.capture?.documentId !== page.driver.inspection().documentId
        ? fail("refused", "Inspection unavailable for this page.")
        : {
            ...result,
            inspection: { ...page.driver.inspection(true), capture: result.inspection?.capture },
          };
    },
    viewport: (threadId, preset) => uiRead(threadId, { op: "viewport", preset }),
    driverOf: (threadId) => pages.get(threadId)?.driving,
    actionOf: (threadId) => pages.get(threadId)?.lastAction,
    recordingOf: (threadId) => pages.get(threadId)?.recording !== undefined,
    closed: (threadId) => {
      once.delete(threadId);
      appOrigins.delete(threadId);
      const page = pages.get(threadId);
      if (page !== undefined) endRecording(page);
      pages.delete(threadId);
      if (
        page !== undefined &&
        !page.contents.isDestroyed() &&
        page.contents.debugger.isAttached()
      ) {
        page.contents.debugger.detach();
      }
    },
  };
}
