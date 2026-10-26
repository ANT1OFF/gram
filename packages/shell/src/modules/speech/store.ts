import {
  FsError,
  SpeechRefused,
  speechModelBytes,
  type SpeechInstallState,
  type SpeechModelManifest,
  type SpeechStatus,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  bytesOnDisk,
  downloadModel,
  freeBytesAt,
  readInstalled,
  recoverReplaced,
  removeModel,
  type FreeBytes,
  type SpeechFetch,
} from "./download.ts";
import { SPEECH_MODELS, speechManifest } from "./manifest.ts";

/** Progress reaches watchers at most this often; a 660 MB download would otherwise flood them. */
const PROGRESS_INTERVAL_MS = 250;

export interface SpeechStoreOptions {
  /** `<dataDir>/speech`. */
  readonly root: string;
  /** Where free space is measured: the data dir, which exists before `root` does. */
  readonly dataDir: string;
  readonly base: string;
  readonly fetch: SpeechFetch;
  readonly freeBytes?: FreeBytes | undefined;
  readonly lookup?: ((id: string) => SpeechModelManifest | undefined) | undefined;
  /** Every pinned model, which start-up checks for an interrupted update. */
  readonly models?: ReadonlyArray<SpeechModelManifest> | undefined;
}

interface Running {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/** Local dictation's model store: one install at a time per model, cancellable, resumable. */
export const makeSpeechStore = (options: SpeechStoreOptions) =>
  Effect.gen(function* () {
    const { root } = options;
    const lookup = options.lookup ?? speechManifest;
    const freeBytes = options.freeBytes ?? freeBytesAt;
    const installs = new Map<string, SpeechInstallState>();
    const running = new Map<string, Running>();
    /** Models being removed, which an install must wait out rather than write into. */
    const removing = new Set<string>();
    const listeners = new Map<string, Set<() => void>>();
    const fibers = yield* FiberMap.make<string>();
    const models = options.models ?? SPEECH_MODELS;
    // Puts back a model an update moved aside when the app quit mid-move. Here, before any RPC can
    // run, so it never races a removal; an install does it again under its own reservation.
    for (const manifest of models)
      yield* Effect.promise(() => recoverReplaced(root, manifest.id).catch(() => undefined));

    const notify = (id: string) => {
      for (const listener of listeners.get(id) ?? []) listener();
    };
    const setInstall = (id: string, state: SpeechInstallState) => {
      installs.set(id, state);
      notify(id);
    };

    const known = (model: string): Effect.Effect<SpeechModelManifest, SpeechRefused> => {
      const manifest = lookup(model);
      return manifest === undefined
        ? Effect.fail(
            new SpeechRefused({
              model,
              reason: "unknown-model",
              message: "This version of Gram doesn't know that speech model.",
            }),
          )
        : Effect.succeed(manifest);
    };

    const statusOf = (manifest: SpeechModelManifest) =>
      Effect.promise(async (): Promise<SpeechStatus> => {
        const [installed, free] = await Promise.all([
          readInstalled(root, manifest).catch(() => undefined),
          freeBytes(options.dataDir),
        ]);
        let install = installs.get(manifest.id);
        if (install === undefined && installed === undefined) {
          // A download a restart cut off still resumes from what it left.
          const resumableBytes = await bytesOnDisk(root, manifest).catch(() => 0);
          install = resumableBytes > 0 ? { state: "idle", resumableBytes } : { state: "idle" };
        }
        return {
          model: manifest,
          ...(installed === undefined ? {} : { installed: { id: manifest.id, ...installed } }),
          install: install ?? { state: "idle" },
          ...(free === undefined ? {} : { freeBytes: free }),
        };
      });

    const watch = (model: string) =>
      Stream.unwrap(
        known(model).pipe(
          Effect.map((manifest) =>
            Stream.callback<void>(
              (queue) => {
                const listener = () => Queue.offerUnsafe(queue, undefined);
                return Effect.acquireRelease(
                  Effect.sync(() => {
                    const set = listeners.get(manifest.id) ?? new Set();
                    set.add(listener);
                    listeners.set(manifest.id, set);
                    listener();
                  }),
                  () => Effect.sync(() => listeners.get(manifest.id)?.delete(listener)),
                );
              },
              // Only the latest change matters: each tick reads the whole status again.
              { bufferSize: 1, strategy: "sliding" },
            ).pipe(Stream.mapEffect(() => statusOf(manifest))),
          ),
        ),
      );

    /** The same upstream checkpoint exported for other chunks: one is installed at a time. */
    const variantsOf = (manifest: SpeechModelManifest) =>
      models.filter(
        (other) => other.id !== manifest.id && other.source.repo === manifest.source.repo,
      );

    /**
     * Deletes the other variants of `manifest`'s model (the same upstream checkpoint, exported for
     * another chunk) once it is in, so one is on disk at a time whoever started the download. A
     * variant downloading or being removed is left alone.
     */
    const removeSuperseded = (manifest: SpeechModelManifest) =>
      Effect.forEach(
        variantsOf(manifest),
        (other) =>
          Effect.suspend(() => {
            if (running.has(other.id) || removing.has(other.id)) return Effect.succeed(false);
            // Reserved before the first await, so an install or removal can't start under it.
            removing.add(other.id);
            return Effect.promise(async () => {
              try {
                if ((await readInstalled(root, other).catch(() => undefined)) === undefined)
                  return false;
                await removeModel(root, other.id);
                return true;
              } finally {
                removing.delete(other.id);
                installs.delete(other.id);
                notify(other.id);
              }
            });
          }).pipe(
            Effect.flatMap((removed) =>
              removed
                ? Effect.logInfo("speech model superseded", { model: other.id, by: manifest.id })
                : Effect.void,
            ),
            Effect.catchCause(() =>
              Effect.logWarning("speech model not removed", { model: other.id }),
            ),
          ),
        { discard: true },
      );

    const install = (model: string) =>
      Effect.gen(function* () {
        const manifest = yield* known(model);
        const id = manifest.id;
        if (running.has(id) || removing.has(id))
          return yield* new SpeechRefused({
            model,
            reason: "busy",
            message: running.has(id)
              ? "The model is already downloading."
              : "The model is being removed.",
          });
        // One variant downloads at a time, so the one that finishes is the one kept.
        const sibling = variantsOf(manifest).find((other) => running.has(other.id));
        if (sibling !== undefined)
          return yield* new SpeechRefused({
            model,
            reason: "busy",
            message: "Another variant of the speech model is downloading. Pause it first.",
          });
        const controller = new AbortController();
        const { promise: done, resolve } = Promise.withResolvers<void>();
        running.set(id, { controller, done });
        const started = Date.now();
        let lastProgress = 0;
        let trailing: ReturnType<typeof setTimeout> | undefined;
        const flush = () => {
          trailing = undefined;
          lastProgress = Date.now();
          notify(id);
        };
        setInstall(id, {
          state: "downloading",
          receivedBytes: 0,
          totalBytes: speechModelBytes(manifest),
        });

        const run = Effect.promise(() =>
          downloadModel({
            manifest,
            root,
            base: options.base,
            fetch: options.fetch,
            signal: controller.signal,
            freeBytes,
            onProgress: (receivedBytes, totalBytes) => {
              installs.set(id, { state: "downloading", receivedBytes, totalBytes });
              if (trailing !== undefined) return;
              const wait = lastProgress + PROGRESS_INTERVAL_MS - Date.now();
              if (wait <= 0) return flush();
              // The latest count still goes out if the transfer stalls right after it.
              trailing = setTimeout(flush, wait);
            },
            onVerifying: () => setInstall(id, { state: "verifying" }),
          }),
        ).pipe(
          Effect.tap((outcome) => {
            if (outcome.ok) {
              installs.delete(id);
              return Effect.logInfo("speech model installed", {
                model: id,
                ms: Date.now() - started,
              }).pipe(Effect.andThen(removeSuperseded(manifest)));
            }
            const resumable =
              outcome.resumableBytes > 0 ? { resumableBytes: outcome.resumableBytes } : {};
            if (outcome.reason === undefined) {
              installs.set(id, { state: "idle", ...resumable });
              return Effect.logInfo("speech model download cancelled", { model: id });
            }
            installs.set(id, {
              state: "failed",
              reason: outcome.reason,
              message: outcome.message,
              ...resumable,
            });
            return Effect.logWarning("speech model download failed", {
              model: id,
              reason: outcome.reason,
              message: outcome.message,
            });
          }),
          // A shutdown mid-download stops the transfer too, rather than leaving it to finish unseen.
          Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
          Effect.ensuring(
            Effect.sync(() => {
              clearTimeout(trailing);
              running.delete(id);
              notify(id);
              resolve();
            }),
          ),
        );
        yield* FiberMap.run(fibers, id, run);
        return yield* statusOf(manifest);
      });

    const cancel = (model: string) =>
      Effect.gen(function* () {
        const manifest = yield* known(model);
        const current = running.get(manifest.id);
        if (current !== undefined) {
          current.controller.abort();
          yield* Effect.promise(() => current.done);
        } else if (installs.get(manifest.id)?.state === "failed") {
          installs.delete(manifest.id);
          notify(manifest.id);
        }
        return yield* statusOf(manifest);
      });

    const remove = (model: string) =>
      Effect.gen(function* () {
        const manifest = yield* known(model);
        if (running.has(manifest.id) || removing.has(manifest.id))
          return yield* new SpeechRefused({
            model,
            reason: "busy",
            message: running.has(manifest.id)
              ? "Cancel the download before removing the model."
              : "The model is already being removed.",
          });
        // Reserved before the first await, so an install can't start writing what this deletes.
        removing.add(manifest.id);
        yield* Effect.tryPromise({
          try: () => removeModel(root, manifest.id),
          catch: (error) => new FsError({ path: root, message: String(error) }),
        }).pipe(Effect.ensuring(Effect.sync(() => removing.delete(manifest.id))));
        installs.delete(manifest.id);
        notify(manifest.id);
        yield* Effect.logInfo("speech model removed", { model: manifest.id });
        return yield* statusOf(manifest);
      });

    return {
      status: (model: string) => known(model).pipe(Effect.flatMap(statusOf)),
      watch,
      install,
      cancel,
      remove,
    };
  });
