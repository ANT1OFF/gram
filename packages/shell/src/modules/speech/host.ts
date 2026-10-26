// Supervises the speech process (`speech-process/`): forks it on the first session or prewarm, hands each
// session one end of a fresh MessageChannelMain while the page gets the other, tells the page when
// the process dies under it, and shuts it down once it has been idle a while, which is the only
// way the model's 1.3 GB goes back to the OS. A crash is reported and never restarts anything by
// itself; the next session forks a fresh process. Nothing here can take the app down.

import {
  DEFAULT_SPEECH_PERFORMANCE,
  isSpeechPerformance,
  SPEECH_PERFORMANCE_STOPS,
  type SpeechOpenRequest,
  type SpeechOpenResult,
} from "@gram/contracts";

import type {
  SpeechCrashPayload,
  SpeechHostMessage,
  SpeechPortPayload,
  SpeechProcessMessage,
} from "../../speech-process/protocol.ts";
import type { SpeechModelResolution } from "./model.ts";

/** How long the process outlives its last session. */
export const SPEECH_IDLE_MS = 5 * 60_000;
/** How long `shutdown` waits for the process to exit by itself before killing it. */
const SHUTDOWN_GRACE_MS = 2_000;

/** The slice of Electron's `UtilityProcess` the host uses. */
export interface SpeechChild {
  postMessage(message: SpeechHostMessage, transfer?: unknown[]): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  kill(): boolean;
}

/** The page that opened a session, as the host reaches it. */
export interface SpeechSender {
  postPort(payload: SpeechPortPayload, port: unknown): void;
  crashed(payload: SpeechCrashPayload): void;
  isDestroyed(): boolean;
}

export interface SpeechHostOptions {
  readonly fork: () => SpeechChild;
  /** `new MessageChannelMain()`. */
  readonly channel: () => { readonly port1: unknown; readonly port2: unknown };
  readonly resolveModel: (modelId: unknown) => Promise<SpeechModelResolution>;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly log: (fields: Readonly<Record<string, unknown>>, message: string) => void;
  readonly idleMs?: number;
}

/** A session id is the page's UUID; anything else is refused before it reaches the process. */
const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value);

/** ONNX Runtime threads for the slider stop `performance`, the default stop's for anything else. */
const threadsFor = (performance: unknown): number =>
  SPEECH_PERFORMANCE_STOPS[
    isSpeechPerformance(performance) ? performance : DEFAULT_SPEECH_PERFORMANCE
  ].threads;

const failure = (message: string): SpeechOpenResult => ({
  ok: false,
  code: "unavailable",
  message,
});

const STOPPED: SpeechOpenResult = {
  ok: false,
  code: "stopped",
  message: "voice input was turned off",
};

export function createSpeechHost(options: SpeechHostOptions) {
  const idleMs = options.idleMs ?? SPEECH_IDLE_MS;
  let child: SpeechChild | null = null;
  /** Open sessions by id: who to tell if the process dies. */
  const sessions = new Map<string, SpeechSender>();
  const prewarms = new Map<number, (result: SpeechOpenResult) => void>();
  let nextRequest = 1;
  let idleTimer: unknown;
  /** Processes the host has let go of that haven't exited yet; `shutdown` waits for them all. */
  const exiting = new Set<Promise<void>>();
  /**
   * Bumped by `shutdown`, so an open or prewarm that was still resolving its model when it began
   * doesn't start a process again after it.
   */
  let generation = 0;
  let updating = false;
  let nativeFault = false;
  interface OwnedChild {
    readonly exited: Promise<number>;
    code?: number;
    forced: boolean;
    orderly: boolean;
  }
  const owned = new Map<SpeechChild, OwnedChild>();

  const clearIdle = () => {
    if (idleTimer === undefined) return;
    options.clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = () => {
    clearIdle();
    if (child === null || sessions.size > 0 || prewarms.size > 0) return;
    idleTimer = options.setTimeout(() => {
      idleTimer = undefined;
      if (sessions.size > 0 || prewarms.size > 0) return;
      options.log({ source: "speech" }, "speech process idle; stopping it");
      void shutdownChild();
    }, idleMs);
  };

  const onMessage = (message: unknown) => {
    const data = message as Partial<SpeechProcessMessage> | null;
    if (data?.type === "ended" && typeof data.sessionId === "string") {
      sessions.delete(data.sessionId);
      armIdle();
    } else if (data?.type === "prewarmed" && typeof data.requestId === "number") {
      const resolve = prewarms.get(data.requestId);
      prewarms.delete(data.requestId);
      resolve?.(data.result ?? failure("the speech process answered nothing"));
      armIdle();
    }
  };

  const ensureChild = (): SpeechChild | string => {
    if (updating) return "voice input is suspended during update finalization";
    if (child !== null) return child;
    let forked: SpeechChild;
    try {
      forked = options.fork();
    } catch (error) {
      return `the speech process didn't start: ${String(error)}`;
    }
    child = forked;
    let observe!: (code: number) => void;
    const record: OwnedChild = {
      exited: new Promise<number>((resolve) => {
        observe = resolve;
      }),
      forced: false,
      orderly: false,
    };
    owned.set(forked, record);
    forked.on("exit", (code) => {
      record.code = code;
      if (record.forced || code !== 0 || (!record.orderly && child === forked)) nativeFault = true;
      observe(code);
      owned.delete(forked);
    });
    forked.on("message", onMessage);
    forked.on("exit", (code) => {
      options.log({ source: "speech", code }, "speech process exited");
      // One the host stopped was detached from it then; this is a process dying by itself.
      if (child !== forked) return;
      child = null;
      clearIdle();
      const message = `the speech process exited with code ${code}`;
      for (const [sessionId, sender] of sessions) {
        if (!sender.isDestroyed()) sender.crashed({ sessionId, message });
      }
      sessions.clear();
      for (const resolve of prewarms.values()) resolve({ ok: false, code: "crashed", message });
      prewarms.clear();
    });
    options.log({ source: "speech" }, "speech process started");
    return forked;
  };

  /**
   * Detaches the process before it exits, so a request in the meantime forks a fresh one rather
   * than going to this one, and fails what was waiting on it.
   */
  const detach = (): SpeechChild | null => {
    clearIdle();
    const dying = child;
    if (dying === null) return null;
    child = null;
    sessions.clear();
    for (const resolve of prewarms.values()) resolve(failure("the speech process was stopped"));
    prewarms.clear();
    const exited = new Promise<void>((resolve) => dying.on("exit", () => resolve()));
    exiting.add(exited);
    void exited.then(() => exiting.delete(exited));
    return dying;
  };

  const stop = () => {
    const dying = detach();
    if (dying) {
      owned.get(dying)!.forced = true;
      dying.kill();
    }
  };

  const shutdownChild = (): Promise<void> => {
    const dying = detach();
    if (dying !== null) {
      owned.get(dying)!.orderly = true;
      const timer = options.setTimeout(() => {
        owned.get(dying)!.forced = true;
        dying.kill();
      }, SHUTDOWN_GRACE_MS);
      dying.on("exit", () => options.clearTimeout(timer));
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess
      dying.postMessage({ type: "shutdown" });
      options.log({ source: "speech" }, "speech process shutting down");
    }
    return Promise.all(exiting).then(() => undefined);
  };

  return {
    /** Opens a session for the page `sender`; the port goes to it before this resolves. */
    async open(input: unknown, sender: SpeechSender): Promise<SpeechOpenResult> {
      const request = (typeof input === "object" && input !== null ? input : {}) as Partial<
        Record<keyof SpeechOpenRequest, unknown>
      >;
      if (!isSessionId(request.sessionId)) return failure("not a session id");
      const language = typeof request.language === "string" ? request.language : undefined;
      const asked = generation;
      const model = await options.resolveModel(request.modelId);
      if (asked !== generation || updating) return STOPPED;
      if (!model.ok) return model;
      const speechProcess = ensureChild();
      if (typeof speechProcess === "string") return failure(speechProcess);
      clearIdle();
      const { port1, port2 } = options.channel();
      sessions.set(request.sessionId, sender);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess
      speechProcess.postMessage(
        {
          type: "open",
          sessionId: request.sessionId,
          model: model.paths,
          threads: threadsFor(request.performance),
          ...(language === undefined ? {} : { language }),
        },
        [port1],
      );
      sender.postPort({ sessionId: request.sessionId }, port2);
      return { ok: true };
    },

    /** Starts the process and loads the model, so the next session doesn't wait for it. */
    async prewarm(modelId: unknown, performance?: unknown): Promise<SpeechOpenResult> {
      const threads = threadsFor(performance);
      const asked = generation;
      const model = await options.resolveModel(modelId);
      if (asked !== generation || updating) return STOPPED;
      if (!model.ok) return model;
      const speechProcess = ensureChild();
      if (typeof speechProcess === "string") return failure(speechProcess);
      clearIdle();
      const requestId = nextRequest++;
      const result = new Promise<SpeechOpenResult>((resolve) => prewarms.set(requestId, resolve));
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess
      speechProcess.postMessage({ type: "prewarm", requestId, model: model.paths, threads });
      return result;
    },

    /**
     * Starts the process and has it load the native runtime, no model: what `--smoke` checks, since
     * only a packaged build can get the addon's unpacking or signing wrong.
     */
    probe(): Promise<SpeechOpenResult> {
      const speechProcess = ensureChild();
      if (typeof speechProcess === "string") return Promise.resolve(failure(speechProcess));
      clearIdle();
      const requestId = nextRequest++;
      const result = new Promise<SpeechOpenResult>((resolve) => prewarms.set(requestId, resolve));
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess
      speechProcess.postMessage({ type: "probe", requestId });
      return result;
    },

    /** Kills the process now, at quit; open sessions see their port close. */
    stop,

    /**
     * Has the process end its session with `stopped` and exit, killing it if it hasn't within
     * `SHUTDOWN_GRACE_MS`. Resolves once every process the host has let go of has exited, so the
     * model's files are free; an open or prewarm already under way when it began is refused.
     */
    shutdown(): Promise<void> {
      generation++;
      return shutdownChild();
    },

    /** Suspends new native work and requires observed graceful zero EXIT for every owned child. */
    async shutdownForUpdate(): Promise<void> {
      updating = true;
      generation++;
      const snapshot = [...owned.values()].filter((record) => record.code === undefined);
      const fault = nativeFault;
      await this.shutdown();
      const codes = await Promise.all(snapshot.map((record) => record.exited));
      if (
        fault ||
        nativeFault ||
        snapshot.some((record) => record.forced || !record.orderly) ||
        codes.some((code) => code !== 0)
      )
        throw new Error("Update refused: speech cleanup was forced, crashed or nonzero");
    },
    /** Waits only for children suspended by this transaction; never starts or kills another one. */
    async waitForUpdateExit(): Promise<void> {
      if (!updating) return;
      await Promise.all([...owned.values()].map((record) => record.exited));
    },
    /** Recovery can fork again only after all previous native children have actually exited. */
    resumeAfterUpdate(): void {
      if (!updating) return;
      if ([...owned.values()].some((record) => record.code === undefined))
        throw new Error("Voice recovery unavailable: an owned speech process is still running");
      owned.clear();
      nativeFault = false;
      updating = false;
    },

    /** Whether the process is running, for tests and diagnostics. */
    running: () => child !== null,
  };
}

export type SpeechHost = ReturnType<typeof createSpeechHost>;
