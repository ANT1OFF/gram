import type { SpeechModelAnswer, SpeechOpenResult } from "@gram/contracts";

/** An installed model as main resolved it: absolute paths of its files, and its streaming chunk. */
export interface SpeechModelPaths {
  readonly encoder: string;
  readonly decoder: string;
  readonly joiner: string;
  readonly tokens: string;
  /** The variant's chunk, from `verified.json`; the flush on `stop` has to cover one. */
  readonly chunkMs: number;
}

/** Which engine a session on the speech process runs: the local recogniser. */
export type SpeechSessionKind = "local";

/**
 * Main → speech process, on its `parentPort`. `open` carries the
 * session's port in `ports[0]`.
 */
export type SpeechHostMessage =
  /** Loads the native runtime and nothing else, for `--smoke`; answered with `prewarmed`. */
  | { readonly type: "probe"; readonly requestId: number }
  /** Ends the open session with `stopped`, then exits. */
  | { readonly type: "shutdown" }
  /**
   * Ends dictation and releases the model without exiting the process.
   */
  | { readonly type: "release" }
  | {
      readonly type: "prewarm";
      readonly requestId: number;
      readonly model: SpeechModelPaths;
      readonly threads: number;
    }
  | {
      readonly type: "open";
      readonly sessionId: string;
      readonly model: SpeechModelPaths;
      readonly threads: number;
      readonly language?: string | undefined;
    };

/** Speech process → main. */
export type SpeechProcessMessage =
  | { readonly type: "prewarmed"; readonly requestId: number; readonly result: SpeechOpenResult }
  /** The session is over, however it ended; main starts the idle clock when none is left. */
  | { readonly type: "ended"; readonly sessionId: string };

/** IPC payload main sends the preload with a session's port. */
export interface SpeechPortPayload {
  readonly sessionId: string;
  /** Absent for local dictation, which every shell had first. */
  readonly kind?: SpeechSessionKind | undefined;
}

/** IPC payload main sends the preload when the speech process died under a session. */
export interface SpeechCrashPayload {
  readonly sessionId: string;
  readonly kind?: SpeechSessionKind | undefined;
  readonly message: string;
}

/** IPC payload the preload sends to start or stop one `models.watch`. */
export interface SpeechModelWatchPayload {
  /** Chosen by the preload, one per `watch` call. */
  readonly watchId: string;
  readonly model?: string | undefined;
}

/** IPC payload main sends the preload with a watched model's new status. */
export interface SpeechModelChangedPayload {
  readonly watchId: string;
  readonly answer: SpeechModelAnswer;
}
