import type { SpeechErrorCode, SpeechOpenResult, SpeechServerMessage } from "@gram/contracts";

import { createUtterance, MAX_CLIP_SAMPLES, planClip, type SpeechSegment } from "./accurate.ts";
import type {
  SpeechAccuratePaths,
  SpeechHostMessage,
  SpeechModelPaths,
  SpeechProcessMessage,
} from "./protocol.ts";

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

/**
 * How long a finished utterance may wait for the offline model, loading it included, before the
 * stream's own text commits instead: short of the page's 5 s wait for the last `final`, so a slow
 * pass costs accuracy once rather than the words.
 */
const ACCURATE_BUDGET_MS = 4_000;

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

/** The offline model and voice activity detector `accurate` mode runs a finished clip through. */
export interface AccuratePass {
  /** Where `samples` holds speech, in order; empty when nobody spoke. */
  segments(samples: Float32Array): readonly SpeechSegment[];
  /** The clip's text, with punctuation and capitals. Off the main thread, so a cancel still lands. */
  transcribe(samples: Float32Array): Promise<string>;
}

/** The native runtime, once it has loaded. */
export interface SpeechRuntime {
  /** Builds a recogniser on a model's files; throws when it refuses them. */
  load(model: SpeechModelPaths, threads: number): Recogniser;
  /** Builds the accurate pass off the main thread, so dictation starts while it loads. */
  loadAccurate(paths: SpeechAccuratePaths): Promise<AccuratePass>;
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

/** What `work` resolves to, or undefined if it fails or takes longer than `ms`. */
const within = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    const settle = (value: T | undefined) => {
      clearTimeout(timer);
      resolve(value);
    };
    work.then(settle, () => settle(undefined));
  });

/**
 * The speech process's state: the native runtime and at most one loaded model, and at most one open
 * session. Everything runs on one thread and decoding is synchronous, which is why this is a process
 * of its own.
 */
export function createSpeechService(options: SpeechServiceOptions) {
  let runtime: SpeechRuntime | { readonly error: string } | undefined;
  let loaded: { readonly key: string; readonly recogniser: Recogniser } | undefined;
  /** Loaded on the first `accurate` session and kept for the next, until the process goes idle. */
  let accurate:
    | { readonly key: string; readonly pass: Promise<AccuratePass | undefined> }
    | undefined;
  /** The offline model's latest clip: one at a time, which a pass given up on can still be. */
  let transcribing: Promise<unknown> = Promise.resolve();
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

  /** The accurate pass, starting its load if it isn't loaded; undefined once it failed to. */
  const accuratePass = (paths: SpeechAccuratePaths): Promise<AccuratePass | undefined> => {
    if (accurate?.key === paths.encoder) return accurate.pass;
    const native = getRuntime();
    if ("error" in native) return Promise.resolve(undefined);
    const startedAt = options.now();
    const key = paths.encoder;
    const pass = native.loadAccurate(paths).then(
      (loadedPass) => {
        options.log("accurate pass loaded", { loadMs: Math.round(options.now() - startedAt) });
        return loadedPass;
      },
      () => {
        // The next session tries again rather than staying on the stream's text for good.
        if (accurate?.key === key) accurate = undefined;
        options.log("accurate pass load failed");
        return undefined;
      },
    );
    accurate = { key, pass };
    return pass;
  };

  const open = (
    sessionId: string,
    port: SessionPort,
    model: SpeechModelPaths,
    threads: number,
    language: string | undefined,
    accuratePaths: SpeechAccuratePaths | undefined,
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
    const pass = accuratePaths === undefined ? undefined : accuratePass(accuratePaths);
    const utterance = createUtterance();
    if (pass !== undefined) utterance.push(LEAD_SILENCE);
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

    /**
     * The text to commit for the utterance just ended: the offline model's, over the clip with its
     * silence trimmed. Nothing when the detector heard nobody, whatever the stream made of it, and
     * the stream's `streamed` when the pass couldn't answer in time. With `more` to come, starts the
     * next utterance too, on any words the clip was cut off in.
     */
    const accurateText = async (
      running: Promise<AccuratePass | undefined>,
      streamed: string,
      more: boolean,
    ): Promise<string> => {
      const clip = utterance.take();
      const at = options.now();
      const work = running.then(async (ready) => {
        if (ready === undefined) return undefined;
        const { speech, carryFrom } = planClip(ready.segments(clip), clip.length, more);
        if (speech === undefined) return { text: "" };
        const heard = clip.subarray(speech.start, speech.end);
        const decoding = transcribing.then(() => ready.transcribe(heard));
        transcribing = decoding.catch(() => undefined);
        const text = (await decoding).trim();
        return carryFrom === undefined ? { text } : { text, carried: clip.slice(carryFrom) };
      });
      const outcome = await within(work, ACCURATE_BUDGET_MS);
      options.log("accurate pass", {
        audioMs: Math.round((clip.length / RATE) * 1000),
        ms: Math.round(options.now() - at),
        fellBack: outcome === undefined ? 1 : 0,
      });
      if (more) utterance.push(outcome?.carried ?? LEAD_SILENCE);
      return outcome?.text ?? streamed;
    };

    const onAudio = (samples: Float32Array): Promise<void> | undefined => {
      frames++;
      stream.accept(samples);
      const text = decode();
      if (pass !== undefined) utterance.push(samples);
      if (stream.isEndpoint() || utterance.length() >= MAX_CLIP_SAMPLES) {
        stream.reset();
        partial = "";
        if (pass !== undefined) {
          return accurateText(pass, text, true).then((committed) => {
            if (live && committed !== "")
              port.postMessage({ type: "final", text: committed, reason: "endpoint" });
          });
        }
        if (text !== "") port.postMessage({ type: "final", text, reason: "endpoint" });
      } else if (text !== partial) {
        partial = text;
        port.postMessage({ type: "partial", text });
      }
      return undefined;
    };

    /** The session's last `final`, unless it ended while that was on its way. */
    const finish = (committed: string) => {
      if (!live) return;
      port.postMessage({ type: "final", text: committed, reason: "stop" });
      end();
    };

    const onStop = (): Promise<void> | undefined => {
      stream.accept(tailSilence(model.chunkMs));
      stream.finish();
      const text = decode();
      if (pass === undefined) {
        finish(text);
        return undefined;
      }
      // The tail the stream got too: a stop can land right on the last word.
      utterance.push(LEAD_SILENCE);
      return accurateText(pass, text, false).then(finish);
    };

    /** One message off the queue; a promise holds the next until the utterance has committed. */
    const handle = (data: unknown): Promise<void> | undefined => {
      const type: unknown =
        typeof data === "object" && data !== null ? Reflect.get(data, "type") : undefined;
      const samples: unknown =
        type === "audio" ? Reflect.get(data as object, "samples") : undefined;
      if (samples instanceof Float32Array && samples.length > 0 && samples.length <= MAX_FRAME) {
        return onAudio(samples);
      }
      if (type === "stop") return onStop();
      end("invalid-message", "expected an audio frame of 1 to 16000 samples, stop or cancel");
      return undefined;
    };

    // Frames wait while an utterance commits, or the next utterance's partials would reach the page
    // ahead of this one's `final`.
    const queue: unknown[] = [];
    let busy = false;
    const pump = () => {
      while (!busy && queue.length > 0) {
        // `handle` can end the session.
        if (!live) return;
        const pending = handle(queue.shift());
        if (pending === undefined) continue;
        busy = true;
        void pending.then(() => {
          busy = false;
          pump();
        });
      }
    };

    port.on("message", ({ data }) => {
      if (!live) return;
      const type: unknown =
        typeof data === "object" && data !== null ? Reflect.get(data, "type") : undefined;
      if (type === "cancel") return end();
      queue.push(data);
      pump();
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
        accurate = undefined;
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
        // Answered without it: dictation can start while it loads, on the stream's text.
        if (!("ok" in recogniser) && message.accurate !== undefined)
          void accuratePass(message.accurate);
        options.send({
          type: "prewarmed",
          requestId: message.requestId,
          result: "ok" in recogniser ? recogniser : { ok: true },
        });
      } else if (message.type === "open") {
        const port = ports[0];
        if (port === undefined) return;
        open(
          message.sessionId,
          port,
          message.model,
          message.threads,
          message.language,
          message.accurate,
        );
      }
    },
  };
}
