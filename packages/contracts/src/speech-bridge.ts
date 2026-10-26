// Local dictation: the renderer streams microphone audio to the desktop shell's speech process over
// a MessagePort and gets text back on it. Desktop-only, like the rest of `DesktopBridge`, and so is
// the model, which the shell's speech module downloads into `<dataDir>/speech`.

import type { SpeechRefusal, SpeechStatus } from "./speech.ts";

/** Samples per second of every audio frame on a session's port. */
export const SPEECH_SAMPLE_RATE = 16_000;

/** Samples in the 100 ms frame the capture worklet sends; any length up to one second is accepted. */
export const SPEECH_FRAME_SAMPLES = 1_600;

/** The longest frame the speech process accepts, one second; a longer one is an `invalid-message`. */
export const SPEECH_MAX_FRAME_SAMPLES = SPEECH_SAMPLE_RATE;

/**
 * Where installed models live, relative to the data dir: `<dataDir>/speech/models/<modelId>/`. The
 * shell renames a model's directory into place once every file is verified, and writes
 * `SPEECH_MODEL_VERIFIED_FILE` last; the shell resolves an id to it, reads which files the
 * recogniser loads from that file, and never takes a path from the page.
 */
export const SPEECH_MODELS_PATH = ["speech", "models"] as const;

/**
 * The file that marks a model directory installed; one without it is not a model. Its
 * `recognizer.chunkMs` names the variant's streaming chunk, 560 when absent.
 */
export const SPEECH_MODEL_VERIFIED_FILE = "verified.json";

/** A model id is one path segment: lowercase letters, digits, `.`, `_` and `-`, not starting with a dot. */
export const isSpeechModelId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);

/**
 * A stop on the voice input performance slider. Measured on an M4 Pro with the Nemotron EN model
 * (int8, greedy): word error rate is flat across them, about 10 %, so a stop trades how soon text
 * appears against CPU, not accuracy.
 */
export type SpeechPerformance = "responsive" | "balanced" | "efficient";

/** The stop a session runs at unless the page names one. */
export const DEFAULT_SPEECH_PERFORMANCE: SpeechPerformance = "balanced";

/**
 * What each stop runs. `chunkMs` is the model variant's streaming chunk, so a stop needs the
 * installed model with that chunk; `threads` is ONNX Runtime's, which the shell applies.
 */
export const SPEECH_PERFORMANCE_STOPS: Readonly<
  Record<SpeechPerformance, { readonly chunkMs: 160 | 560 | 1120; readonly threads: 1 | 2 }>
> = {
  /** Text about every 0.2 s, first words 0.3 s sooner; about 65 % of one core while dictating. */
  responsive: { chunkMs: 160, threads: 2 },
  /** Text about every 0.6 s; about 26 % of one core. */
  balanced: { chunkMs: 560, threads: 2 },
  /** Text about every 1.2 s; about 13 % of one core. */
  efficient: { chunkMs: 1120, threads: 1 },
};

export const isSpeechPerformance = (value: unknown): value is SpeechPerformance =>
  value === "responsive" || value === "balanced" || value === "efficient";

/** What the page asks for when it opens a session. */
export interface SpeechOpenRequest {
  /** Chosen by the page (a UUID), so it can listen for the port before asking for it. */
  readonly sessionId: string;
  /** An installed model, as the server's model status names it. */
  readonly modelId: string;
  /** A language code for a multilingual model; ignored by an English-only one. */
  readonly language?: string | undefined;
  /**
   * The slider's stop, `DEFAULT_SPEECH_PERFORMANCE` when absent. `modelId` should be the variant
   * with its `chunkMs`. A change takes effect at the next session; one never changes mid-session.
   */
  readonly performance?: SpeechPerformance | undefined;
}

/** Why a session couldn't open, ended early, or why the speech process can't run here. */
export type SpeechErrorCode =
  /** The model isn't installed: no `verified.json`, or a file it names is missing or the wrong size. */
  | "model-missing"
  /** The recogniser refused the model's files. */
  | "model-load-failed"
  /** The native runtime didn't load on this computer (an unsupported platform, a broken install). */
  | "unavailable"
  /** The speech process exited mid-session; the next session starts a fresh one. */
  | "crashed"
  /** Another session, maybe in another window, opened and took over. */
  | "superseded"
  /** The page sent something that isn't a `SpeechClientMessage`. */
  | "invalid-message"
  /** Voice input was turned off, and `shutdown` stopped the speech process. */
  | "stopped";

/** `open`'s answer. The port itself arrives as a window message, see `openSpeechSession`. */
export type SpeechOpenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SpeechErrorCode; readonly message: string };

/**
 * Page → speech process, on the session's port. Frames are copied, never transferred: a transferred
 * buffer reaches Electron's `MessagePortMain` as `null`.
 */
export type SpeechClientMessage =
  /** Mono samples in [-1, 1] at `SPEECH_SAMPLE_RATE`, normally `SPEECH_FRAME_SAMPLES` of them. */
  | { readonly type: "audio"; readonly samples: Float32Array }
  /** Finish: what was heard so far comes back as one last `final`, then the port closes. */
  | { readonly type: "stop" }
  /** Discard: nothing more comes back and the port closes. Closing the port does the same. */
  | { readonly type: "cancel" };

/** Speech process → page, on the session's port. */
export type SpeechServerMessage =
  /** The model is loaded; frames sent before this were queued, not lost. */
  | { readonly type: "ready"; readonly loadMs: number }
  /** The words of the current utterance so far, replacing the previous partial. */
  | { readonly type: "partial"; readonly text: string }
  /**
   * The utterance is committed and the next partial starts a new one: the speaker paused
   * (`endpoint`), or the page sent `stop`, in which case this is the last message. `text` can be empty.
   */
  | { readonly type: "final"; readonly text: string; readonly reason: "endpoint" | "stop" }
  /** The session is over and the port closes. */
  | { readonly type: "error"; readonly code: SpeechErrorCode; readonly message: string };

/** The system's microphone permission for the app, as macOS (or Windows) reports it. */
export type MicrophoneAccess = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

/**
 * Why a model store call failed, as plain data: a tagged error doesn't survive IPC, so the page
 * makes `SpeechRefused` or `FsError` again from it.
 */
export type SpeechModelFailure =
  | {
      readonly _tag: "SpeechRefused";
      readonly model: string;
      readonly reason: SpeechRefusal;
      readonly message: string;
    }
  | { readonly _tag: "FsError"; readonly path: string; readonly message: string };

/** A model store call's answer. */
export type SpeechModelAnswer =
  | { readonly ok: true; readonly status: SpeechStatus }
  | { readonly ok: false; readonly error: SpeechModelFailure };

/**
 * Local dictation's model store, which the shell keeps under `<dataDir>/speech`: one install at a
 * time per model, cancellable and resumable. Every call names a model the app version pins.
 */
export interface SpeechModels {
  /** The model's pinned manifest, whether it is installed, and any install under way. */
  status(model: string): Promise<SpeechModelAnswer>;
  /**
   * Downloads the model's pinned archive, resuming a partial one, verifies it and every file in it,
   * and moves it into place; answers with the status it started in. Failures arrive as the `failed`
   * install state, not as errors.
   */
  install(model: string): Promise<SpeechModelAnswer>;
  /** Stops a download, keeping what arrived so the next install resumes from it. */
  cancel(model: string): Promise<SpeechModelAnswer>;
  /** Deletes the installed model and any partial download of it. */
  remove(model: string): Promise<SpeechModelAnswer>;
  /** `status` now and on each change, download progress included; returns the unsubscribe. */
  watch(model: string, callback: (answer: SpeechModelAnswer) => void): () => void;
}

/** Local dictation on `window.gram.speech`; absent in a browser. */
export interface DesktopSpeech {
  /** The model store. Absent from shells that predate it, whose server kept the models. */
  readonly models?: SpeechModels | undefined;
  /**
   * Opens a session on model `modelId`, starting the speech process if it isn't running. On `ok`
   * the session's port is posted to the window; `openSpeechSession` wraps the two.
   */
  open(request: SpeechOpenRequest): Promise<SpeechOpenResult>;
  /**
   * Starts the speech process and loads `modelId` without opening a session, to hide the second or
   * so a load takes; for when the composer gains focus with voice on. Never rejects.
   */
  prewarm(modelId: string, performance?: SpeechPerformance): Promise<SpeechOpenResult>;
  /** The microphone permission now, without asking. */
  microphoneAccess(): Promise<MicrophoneAccess>;
  /** Asks macOS for the microphone once (later calls just report); elsewhere reports. */
  requestMicrophoneAccess(): Promise<MicrophoneAccess>;
  /** Opens the system's microphone privacy settings; resolves false where there are none. */
  openMicrophoneSettings(): Promise<boolean>;
  /**
   * Ends any open session (`stopped`) and stops the speech process now, rather than after it has
   * idled, so the model's memory goes back at once: for turning voice input off. Resolves once the
   * process has exited, or at once when none is running; the next session starts a fresh one.
   * Absent from shells that predate it.
   */
  shutdown?(): Promise<void>;
}

/** The window message that carries a session's port, `event.ports[0]`, from the preload. */
export const SPEECH_PORT_MESSAGE = "gram:speech-port";

/** The `data` of a `SPEECH_PORT_MESSAGE` window message. */
export interface SpeechPortMessage {
  readonly type: typeof SPEECH_PORT_MESSAGE;
  readonly sessionId: string;
}

/** The window a session's port is posted to: `window`, or a stand-in in tests. */
export interface SpeechPortTarget {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/**
 * Opens a session and resolves with its port once it arrives, or with the reason it can't open.
 * Post `SpeechClientMessage`s on the port and read `SpeechServerMessage`s from it.
 */
export function openSpeechSession(
  speech: DesktopSpeech,
  request: SpeechOpenRequest,
  target: SpeechPortTarget,
): Promise<
  | { readonly ok: true; readonly port: MessagePort }
  | Extract<SpeechOpenResult, { readonly ok: false }>
> {
  return openPortSession(() => speech.open(request), request.sessionId, target, "unavailable");
}

/**
 * `open`s a session whose port the shell posts to the window as a `SPEECH_PORT_MESSAGE`, and
 * resolves with the port once it arrives, or with why it can't open: any session on the speech
 * process, local dictation's, a call's or gateway dictation's. An `open` that throws answers with
 * `thrown` as its code.
 */
export function openPortSession<Code extends string>(
  open: () => Promise<
    { readonly ok: true } | { readonly ok: false; readonly code: Code; readonly message: string }
  >,
  sessionId: string,
  target: SpeechPortTarget,
  thrown: Code,
): Promise<
  | { readonly ok: true; readonly port: MessagePort }
  | { readonly ok: false; readonly code: Code; readonly message: string }
> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      const data: unknown = event.data;
      const port = event.ports[0];
      if (
        typeof data !== "object" ||
        data === null ||
        Reflect.get(data, "type") !== SPEECH_PORT_MESSAGE ||
        Reflect.get(data, "sessionId") !== sessionId ||
        port === undefined
      ) {
        return;
      }
      target.removeEventListener("message", listener);
      resolve({ ok: true, port });
    };
    // Before `open`: the port can arrive ahead of its answer.
    target.addEventListener("message", listener);
    // Through a Promise of its own, so an `open` that throws rather than rejects still cleans up.
    void new Promise<Awaited<ReturnType<typeof open>>>((answer) => answer(open())).then(
      (result) => {
        if (result.ok) return;
        target.removeEventListener("message", listener);
        resolve(result);
      },
      (error: unknown) => {
        target.removeEventListener("message", listener);
        resolve({ ok: false, code: thrown, message: String(error) });
      },
    );
  });
}

/**
 * What to tell the user when `getUserMedia` refuses the microphone, by the `DOMException`'s name.
 * The shell grants its own pages the microphone, so a `NotAllowedError` is the operating system's
 * privacy setting, which on Windows is "Let desktop apps access your microphone".
 */
export function microphoneErrorMessage(error: { readonly name: string }, platform: string): string {
  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return platform === "win32"
        ? "Windows is blocking the microphone. Turn on Settings → Privacy & security → Microphone → Let desktop apps access your microphone, then try again."
        : platform === "darwin"
          ? "macOS is blocking the microphone for Gram. Allow it in System Settings → Privacy & Security → Microphone, then try again."
          : "The system is blocking the microphone.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Connect one, or choose one in the system's sound settings.";
    case "NotReadableError":
    case "AbortError":
      return platform === "win32"
        ? "The microphone couldn't be opened. Another app may be using it, or Windows' microphone privacy setting is off."
        : "The microphone couldn't be opened. Another app may be using it.";
    default:
      return `The microphone couldn't be opened (${error.name}).`;
  }
}
