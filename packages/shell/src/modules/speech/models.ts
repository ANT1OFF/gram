// Local dictation's model store as main serves it: the one door to `store.ts`, which keeps the
// Effect it had on the server, so the rest of main sees Promises and plain
// answers that cross IPC, and the store's log lines reach the shell's log.

import { join } from "node:path";

import type { SpeechModelAnswer, SpeechModelFailure, SpeechStatus } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ShellLog } from "../../core/log.ts";
import type { SpeechFetch } from "./download.ts";
import { DEFAULT_HF_BASE } from "./manifest.ts";
import { makeSpeechStore } from "./store.ts";

/**
 * Where model files come from: `GRAM_HF_BASE`, a mirror serving the Hub's `resolve` paths
 * such as npm registry's Hugging Face remote, else the Hub. HTTPS only, and no credentials in the URL: it
 * is logged and shown in errors. The pinned revision and digests stay the same whatever the host.
 */
export function speechModelBase(env: Readonly<Record<string, string | undefined>>): string {
  const base = env["GRAM_HF_BASE"]?.trim();
  return base !== undefined && /^https:\/\/[^\s/@?#]+(?:\/[^\s?#]*)?$/.test(base)
    ? base
    : DEFAULT_HF_BASE;
}

/** The store, as main's IPC calls it. A `model` is whatever the page sent. */
export interface SpeechModelStore {
  status(model: unknown): Promise<SpeechModelAnswer>;
  install(model: unknown): Promise<SpeechModelAnswer>;
  cancel(model: unknown): Promise<SpeechModelAnswer>;
  remove(model: unknown): Promise<SpeechModelAnswer>;
  /** Calls `onAnswer` with the status now and on each change, until `signal` aborts. */
  watch(model: unknown, onAnswer: (answer: SpeechModelAnswer) => void, signal: AbortSignal): void;
  /** Stops any download, keeping what arrived for the next install to resume from. */
  close(): Promise<void>;
}

export interface SpeechModelStoreOptions {
  /** `<dataDir>`; models go under `<dataDir>/speech`, where the server kept them before. */
  readonly dataDir: string;
  /** `speechModelBase(process.env)`. */
  readonly base: string;
  /** Electron's `net` (`electronFetch`), so the system proxy and the keychain's roots apply. */
  readonly fetch: SpeechFetch;
  readonly log: ShellLog;
}

/** An Effect log line's parts: its text, and the fields of any object logged beside it. */
const lineOf = (message: unknown): { text: string; fields: Record<string, unknown> } => {
  const parts = Array.isArray(message) ? (message as unknown[]) : [message];
  const fields: Record<string, unknown> = {};
  const words: string[] = [];
  for (const part of parts) {
    if (typeof part === "object" && part !== null) Object.assign(fields, part);
    else words.push(String(part));
  }
  return { text: words.join(" "), fields };
};

const failureOf = (error: unknown): SpeechModelFailure | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const tag: unknown = Reflect.get(error, "_tag");
  const message = String(Reflect.get(error, "message"));
  if (tag === "SpeechRefused") {
    return {
      _tag: tag,
      model: String(Reflect.get(error, "model")),
      reason: Reflect.get(error, "reason") as Extract<
        SpeechModelFailure,
        { _tag: typeof tag }
      >["reason"],
      message,
    };
  }
  if (tag === "FsError") return { _tag: tag, path: String(Reflect.get(error, "path")), message };
  return undefined;
};

// The store's ids are strings; anything else from the page is a model it doesn't know.
const idOf = (model: unknown) => (typeof model === "string" ? model : "");

/** Opens the store, first putting back a model an update moved aside when the app quit mid-move. */
export async function openSpeechModelStore(
  options: SpeechModelStoreOptions,
): Promise<SpeechModelStore> {
  const logger = Logger.make(({ logLevel, message }) => {
    const { text, fields } = lineOf(message);
    const line = { source: "speech-models", ...fields };
    if (logLevel === "Error" || logLevel === "Fatal") options.log.error(line, text);
    else if (logLevel === "Warn") options.log.warn(line, text);
    else options.log.info(line, text);
  });
  const loggers = Logger.layer([logger]);
  const scope = Scope.makeUnsafe();
  const store = await Effect.runPromise(
    makeSpeechStore({
      root: join(options.dataDir, "speech"),
      dataDir: options.dataDir,
      base: options.base,
      fetch: options.fetch,
    }).pipe(Scope.provide(scope), Effect.provide(loggers)),
  );

  const answer = async <E>(effect: Effect.Effect<SpeechStatus, E>): Promise<SpeechModelAnswer> => {
    const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(loggers)));
    if (Exit.isSuccess(exit)) return { ok: true, status: exit.value };
    const error = failureOf(Cause.squash(exit.cause));
    if (error !== undefined) return { ok: false, error };
    throw Cause.squash(exit.cause);
  };

  return {
    status: (model) => answer(store.status(idOf(model))),
    install: (model) => answer(store.install(idOf(model))),
    cancel: (model) => answer(store.cancel(idOf(model))),
    remove: (model) => answer(store.remove(idOf(model))),
    watch: (model, onAnswer, signal) => {
      void Effect.runPromiseExit(
        Stream.runForEach(store.watch(idOf(model)), (status) =>
          Effect.sync(() => onAnswer({ ok: true, status })),
        ).pipe(Effect.provide(loggers)),
        { signal },
      ).then((exit) => {
        if (Exit.isSuccess(exit) || signal.aborted) return;
        const error = failureOf(Cause.squash(exit.cause));
        if (error !== undefined) onAnswer({ ok: false, error });
        else options.log.warn({ source: "speech-models" }, "speech model watch failed");
      });
    },
    // Interrupting the store's fibers aborts any download, as the server's shutdown did.
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
