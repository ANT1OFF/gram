import type { SpeechErrorCode, SpeechOpenResult, SpeechServerMessage } from "@gram/contracts";

import type { SpeechHostMessage, SpeechModelPaths, SpeechProcessMessage } from "./protocol.ts";

const RATE = 16_000;
const MAX_FRAME = RATE;
/**
 * A transducer drops a first word that starts on sample zero (19.8 % WER without this, 9.5 % with
 * it, in the study); real speech after a key press has silence in front of it, and this makes sure.
 */
const LEAD_SILENCE = new Float32Array(Math.round(RATE * 0.3));
/**
 * Silence fed on `stop` to flush the last words through the encoder: a whole chunk and a little,
 * or the last words go unheard (1120 ms chunks lost 12 % of words to a 600 ms tail).
 */
const tailSilence = (chunkMs: number) =>
  new Float32Array(Math.round((RATE * Math.max(600, chunkMs + 100)) / 1000));

/** One utterance stream on a loaded model. */
export interface RecogniserStream {
  accept(samples: Float32Array): void;
  /** Decodes whatever input is ready and returns the text of the current utterance. */
  decode(): string;
  /** The recogniser heard the speaker stop (trailing silence after speech). */
  isEndpoint(): boolean;
  /** Starts a new utterance on the same stream. */
  reset(): void;
  /** No more input: the next `decode` flushes everything. */
  finish(): void;
}

export interface Recogniser {
  createStream(language: string | undefined): RecogniserStream;
}

/** The native runtime, once it has loaded. */
export interface SpeechRuntime {
  /** Builds a recogniser on a model's files; throws when it refuses them. */
  load(model: SpeechModelPaths, threads: number): Recogniser;
}

/** The slice of Electron's `MessagePortMain` a session uses. */
export interface SessionPort {
  postMessage(message: SpeechServerMessage): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  start(): void;
  close(): void;
}

/**
 * Log lines carry an event name and numbers only, so no audio or transcript text can reach a log
 * through them.
 */
export type SpeechLog = (event: string, fields?: Readonly<Record<string, number>>) => void;

export interface SpeechServiceOptions {
  /** Loads the native addon; throws when it can't, which makes every request `unavailable`. */
  readonly loadRuntime: () => SpeechRuntime;
  readonly send: (message: SpeechProcessMessage) => void;
  readonly log: SpeechLog;
  readonly now: () => number;
  /** Exits the process, once what was posted has had a moment to go. */
  readonly exit: () => void;
}

const failure = (code: SpeechErrorCode, message: string) => ({ ok: false, code, message }) as const;

const keyOf = (model: SpeechModelPaths, threads: number) => `${model.encoder}\0${threads}`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The speech process's state: the native runtime and at most one loaded model, and at most one open
 * session. Everything runs on one thread and decoding is synchronous, which is why this is a process
 * of its own.
 */
export function createSpeechService(options: SpeechServiceOptions) {
  let runtime: SpeechRuntime | { readonly error: string } | undefined;
  let loaded: { readonly key: string; readonly recogniser: Recogniser } | undefined;
  let active: { readonly end: (code: SpeechErrorCode, message: string) => void } | null = null;

  const getRuntime = (): SpeechRuntime | { readonly error: string } => {
    if (runtime === undefined) {
      try {
        runtime = options.loadRuntime();
      } catch (error) {
        runtime = { error: errorText(error) };
        options.log("runtime unavailable");
      }
    }
    return runtime;
  };

  /** The recogniser for `model`, loading it (about a second) unless it is the one loaded. */
  const recogniserFor = (
    model: SpeechModelPaths,
    threads: number,
  ): Recogniser | Extract<SpeechOpenResult, { ok: false }> => {
    const key = keyOf(model, threads);
    if (loaded?.key === key) return loaded.recogniser;
    const native = getRuntime();
    if ("error" in native) return failure("unavailable", native.error);
    // Drop the old model before loading the next, so two never sit in memory together.
    loaded = undefined;
    const startedAt = options.now();
    try {
      const recogniser = native.load(model, threads);
      loaded = { key, recogniser };
      options.log("model loaded", { loadMs: Math.round(options.now() - startedAt), threads });
      return recogniser;
    } catch (error) {
      options.log("model load failed");
      return failure("model-load-failed", errorText(error));
    }
  };

  const open = (
    sessionId: string,
    port: SessionPort,
    model: SpeechModelPaths,
    threads: number,
    language: string | undefined,
  ) => {
    active?.end("superseded", "another dictation session took over");
    const startedAt = options.now();
    const recogniser = recogniserFor(model, threads);
    if ("ok" in recogniser) {
      port.postMessage({ type: "error", code: recogniser.code, message: recogniser.message });
      port.close();
      options.send({ type: "ended", sessionId });
      return;
    }

    const stream = recogniser.createStream(language);
    stream.accept(LEAD_SILENCE);
    let partial = "";
    let frames = 0;
    let decodeMs = 0;
    let live = true;

    const end = (code?: SpeechErrorCode, message = "") => {
      if (!live) return;
      live = false;
      if (code !== undefined) port.postMessage({ type: "error", code, message });
      port.close();
      if (active === session) active = null;
      options.log("session ended", { frames, decodeMs: Math.round(decodeMs) });
      options.send({ type: "ended", sessionId });
    };

    const decode = (): string => {
      const at = options.now();
      const text = stream.decode().trim();
      decodeMs += options.now() - at;
      return text;
    };

    const onAudio = (samples: Float32Array) => {
      frames++;
      stream.accept(samples);
      const text = decode();
      if (stream.isEndpoint()) {
        if (text !== "") port.postMessage({ type: "final", text, reason: "endpoint" });
        stream.reset();
        partial = "";
      } else if (text !== partial) {
        partial = text;
        port.postMessage({ type: "partial", text });
      }
    };

    const onStop = () => {
      stream.accept(tailSilence(model.chunkMs));
      stream.finish();
      port.postMessage({ type: "final", text: decode(), reason: "stop" });
      end();
    };

    port.on("message", ({ data }) => {
      if (!live) return;
      const type: unknown =
        typeof data === "object" && data !== null ? Reflect.get(data, "type") : undefined;
      const samples: unknown =
        type === "audio" ? Reflect.get(data as object, "samples") : undefined;
      if (samples instanceof Float32Array && samples.length > 0 && samples.length <= MAX_FRAME) {
        onAudio(samples);
      } else if (type === "stop") {
        onStop();
      } else if (type === "cancel") {
        end();
      } else {
        end("invalid-message", "expected an audio frame of 1 to 16000 samples, stop or cancel");
      }
    });
    port.on("close", () => end());
    const session = { end };
    active = session;
    port.postMessage({ type: "ready", loadMs: Math.round(options.now() - startedAt) });
    port.start();
  };

  return {
    /** Handles one message from main; `ports` are the message's transferred ports. */
    receive(message: SpeechHostMessage, ports: readonly SessionPort[]) {
      if (message.type === "probe") {
        const native = getRuntime();
        options.send({
          type: "prewarmed",
          requestId: message.requestId,
          result: "error" in native ? failure("unavailable", native.error) : { ok: true },
        });
      } else if (message.type === "shutdown") {
        active?.end("stopped", "voice input was turned off");
        options.exit();
      } else if (message.type === "release") {
        active?.end("stopped", "voice input was turned off");
        // sherpa frees a recogniser only once it is collected, so drop the last reference to it.
        loaded = undefined;
      } else if (message.type === "prewarm") {
        // An open session's stream holds its recogniser, and sherpa frees one only when it is
        // collected, so loading another now would put two models in memory together.
        if (active !== null && loaded?.key !== keyOf(message.model, message.threads)) {
          options.send({
            type: "prewarmed",
            requestId: message.requestId,
            result: failure("superseded", "a dictation session is using another model"),
          });
          return;
        }
        const recogniser = recogniserFor(message.model, message.threads);
        options.send({
          type: "prewarmed",
          requestId: message.requestId,
          result: "ok" in recogniser ? recogniser : { ok: true },
        });
      } else if (message.type === "open") {
        const port = ports[0];
        if (port === undefined) return;
        open(message.sessionId, port, message.model, message.threads, message.language);
      }
    },
  };
}
