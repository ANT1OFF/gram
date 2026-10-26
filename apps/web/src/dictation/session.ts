import {
  SPEECH_FRAME_SAMPLES,
  type MicrophoneAccess,
  type SpeechClientMessage,
  type SpeechErrorCode,
  type SpeechOpenRequest,
  type SpeechPerformance,
  type SpeechServerMessage,
} from "@gram/contracts";

/**
 * One dictation, from the mic button or the shortcut to the text it commits: opens a session on the
 * desktop shell's local speech process, streams microphone frames into it,
 * and hands back partials to show and finals to commit. Messages travel through a dedicated port,
 * so nothing here knows which runs. Audio and text stay in memory; nothing here logs either.
 */

/** Why dictation couldn't start or stopped early, beyond the speech process's own reasons. */
type DictationErrorCode =
  | SpeechErrorCode
  /** The user or policy refused the microphone. */
  | "microphone-denied"
  /** No input device, or it couldn't be opened. */
  | "microphone-unavailable"
  /** The stop never got its last message back. */
  | "timeout";

export type DictationState =
  | { readonly phase: "idle" }
  /** Asking for the microphone and opening the session; the model may still be loading. */
  | { readonly phase: "starting" }
  | { readonly phase: "listening" }
  /** Stopped capturing; waiting for the last of the text. */
  | { readonly phase: "stopping" }
  | { readonly phase: "error"; readonly code: DictationErrorCode; readonly message: string };

/** What a session's port says: the local speech process's messages. */
type DictationServerMessage =
  | Exclude<SpeechServerMessage, { readonly type: "error" }>
  | { readonly type: "error"; readonly code: DictationErrorCode; readonly message: string };

/** The page's end of a session's port, as `MessagePort` is. */
export interface DictationPort {
  postMessage(message: SpeechClientMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start(): void;
  close(): void;
}

type OpenResult =
  | { readonly ok: true; readonly port: DictationPort }
  | { readonly ok: false; readonly code: DictationErrorCode; readonly message: string };

/** A running microphone capture. */
export interface Capture {
  stop(): void;
}

/**
 * What a session runs: an installed model at the slider's stop.
 */
export interface DictationTarget {
  readonly modelId: string;
  readonly performance?: SpeechPerformance | undefined;
}
type DictationOpenRequest = SpeechOpenRequest;

/**
 * Whether a start may go ahead, asked first, inside the start a cancel can overtake; it may answer
 * with another target, an installed variant while the chosen one downloads.
 */
export type Preflight =
  | { readonly ok: true; readonly target?: DictationTarget | undefined }
  | { readonly ok: false; readonly code: DictationErrorCode; readonly message: string };

export interface DictationDeps {
  /** Checks the model is installed, say; a start goes no further when it says no. */
  readonly preflight?: ((target: DictationTarget) => Promise<Preflight>) | undefined;
  readonly open: (request: DictationOpenRequest) => Promise<OpenResult>;
  /** Asks for the microphone where the OS needs asking first; absent where the browser asks. */
  readonly requestMicrophone?: (() => Promise<MicrophoneAccess>) | undefined;
  /** Starts the microphone; rejects with the `getUserMedia` error. */
  readonly startCapture: (onFrame: (samples: Float32Array) => void) => Promise<Capture>;
  readonly newSessionId: () => string;
  /** How long a stop waits for its last `final`. */
  readonly stopTimeoutMs?: number | undefined;
}

export interface DictationEvents {
  readonly onState: (state: DictationState) => void;
  /** The words heard so far of the utterance not yet committed; `""` once it is. */
  readonly onPartial: (text: string) => void;
  /** Text to put into the draft. Never sends. */
  readonly onCommit: (text: string) => void;
}

/**
 * Silence sent ahead of the first frame: the transducer drops a first word that starts on sample
 * zero, which the study measured as nearly doubling the word error rate.
 */
export const LEAD_SILENCE_FRAMES = 3;

const STOP_TIMEOUT_MS = 5_000;

/** What a `getUserMedia` rejection means for the user. */
const captureError = (error: unknown): { code: DictationErrorCode; message: string } => {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      code: "microphone-denied",
      message: "Microphone access is off for Gram.",
    };
  return {
    code: "microphone-unavailable",
    message:
      name === "NotFoundError" ? "No microphone was found." : "The microphone couldn't be opened.",
  };
};

const DENIED: ReadonlySet<MicrophoneAccess> = new Set(["denied", "restricted"]);

/** How far up the scale ordinary speech reaches: its RMS sits around 0.05–0.2 of full scale. */
const LOUDNESS_GAIN = 5;

/** How loud a frame of microphone samples is, from 0 (silence) to 1, for the listening bars. */
export const loudness = (samples: Float32Array): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / samples.length) * LOUDNESS_GAIN);
};

export interface Dictation {
  readonly state: () => DictationState;
  /** How loud the microphone was in its latest frame while listening, from 0 to 1; else 0. */
  readonly level: () => number;
  start(target: DictationTarget): Promise<void>;
  /** Stops listening; what was heard still commits. */
  stop(): void;
  /** Stops and throws away the uncommitted words. */
  cancel(): void;
}

export function createDictation(deps: DictationDeps, events: DictationEvents): Dictation {
  let state: DictationState = { phase: "idle" };
  let port: DictationPort | undefined;
  let capture: Capture | undefined;
  let partial = "";
  let level = 0;
  const listener = (event: MessageEvent) => onMessage(event.data as DictationServerMessage);
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every start and end, so an answer to a superseded start is ignored. */
  let generation = 0;

  const set = (next: DictationState) => {
    state = next;
    events.onState(next);
  };
  const setPartial = (text: string) => {
    if (text === partial) return;
    partial = text;
    events.onPartial(text);
  };

  /** Releases the microphone and the port; `then` is the state it ends in. */
  const end = (then: DictationState) => {
    generation += 1;
    clearTimeout(stopTimer);
    stopTimer = undefined;
    capture?.stop();
    capture = undefined;
    level = 0;
    if (port !== undefined) {
      port.removeEventListener("message", listener);
      port.close();
      port = undefined;
    }
    setPartial("");
    set(then);
  };

  const commit = (text: string) => {
    const trimmed = text.trim();
    setPartial("");
    if (trimmed !== "") events.onCommit(trimmed);
  };

  const onMessage = (message: DictationServerMessage) => {
    switch (message.type) {
      case "ready":
        return;
      case "partial":
        return setPartial(message.text);
      case "final":
        commit(message.text);
        if (message.reason === "stop") end({ phase: "idle" });
        return;
      case "error":
        return end({ phase: "error", code: message.code, message: message.message });
    }
  };

  const start = async (wanted: DictationTarget) => {
    if (state.phase === "starting" || state.phase === "listening" || state.phase === "stopping")
      return;
    const mine = ++generation;
    set({ phase: "starting" });

    const ready = await (
      deps.preflight?.(wanted) ?? Promise.resolve<Preflight>({ ok: true })
    ).catch((): Preflight => ({
      ok: false,
      code: "unavailable",
      message: "Voice input isn't available.",
    }));
    if (mine !== generation) return;
    if (!ready.ok) return end({ phase: "error", code: ready.code, message: ready.message });

    const access = await deps.requestMicrophone?.().catch(() => "unknown" as const);
    if (mine !== generation) return;
    if (access !== undefined && DENIED.has(access))
      return end({ phase: "error", ...captureError({ name: "NotAllowedError" }) });

    const target = ready.target ?? wanted;
    const sessionId = deps.newSessionId();
    const request: DictationOpenRequest = {
      sessionId,
      modelId: target.modelId,
      ...(target.performance === undefined ? {} : { performance: target.performance }),
    };
    const opened = await deps.open(request).catch((): OpenResult => ({
      ok: false,
      code: "unavailable",
      message: "Couldn't start dictation. Try again; if it keeps failing, send a support bundle.",
    }));
    if (mine !== generation) {
      if (opened.ok) opened.port.close();
      return;
    }
    if (!opened.ok) return end({ phase: "error", code: opened.code, message: opened.message });
    port = opened.port;
    port.addEventListener("message", listener);
    port.start();

    let started: Capture;
    try {
      started = await deps.startCapture((samples) => {
        // Copied, never transferred: a transferred buffer reaches the speech process as `null`.
        if (state.phase !== "listening") return;
        level = loudness(samples);
        port?.postMessage({ type: "audio", samples });
      });
    } catch (error) {
      if (mine === generation) end({ phase: "error", ...captureError(error) });
      return;
    }
    if (mine !== generation) return started.stop();
    capture = started;
    for (let i = 0; i < LEAD_SILENCE_FRAMES; i++)
      port.postMessage({ type: "audio", samples: new Float32Array(SPEECH_FRAME_SAMPLES) });
    set({ phase: "listening" });
  };

  const stop = () => {
    if (state.phase === "starting") return cancel();
    if (state.phase !== "listening" || port === undefined) return;
    capture?.stop();
    capture = undefined;
    level = 0;
    port.postMessage({ type: "stop" });
    set({ phase: "stopping" });
    stopTimer = setTimeout(() => {
      // The last message never came: keep what was shown rather than lose it.
      commit(partial);
      end({ phase: "idle" });
    }, deps.stopTimeoutMs ?? STOP_TIMEOUT_MS);
  };

  const cancel = () => {
    if (state.phase === "idle" || state.phase === "error") {
      if (state.phase === "error") set({ phase: "idle" });
      return;
    }
    port?.postMessage({ type: "cancel" });
    end({ phase: "idle" });
  };

  return { state: () => state, level: () => level, start, stop, cancel };
}

/** `text` as it should follow `before` in the draft: a space between words, none after a newline. */
export const spacedAfter = (before: string, text: string): string =>
  before === "" || /\s$/.test(before) ? text : ` ${text}`;
