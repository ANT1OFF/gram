import {
  FsError,
  SpeechRefused,
  type SpeechModelAnswer,
  type SpeechModelId,
  type SpeechModels,
  type SpeechStatus,
} from "@gram/contracts";

import type { SpeechApi } from "./types";

type ModelsApi = Pick<
  SpeechApi,
  | "speechStatus"
  | "watchSpeechInstall"
  | "installSpeechModel"
  | "cancelSpeechInstall"
  | "removeSpeechModel"
>;

/** The status in `answer`, or the tagged error it names, made again as the RPCs threw it. */
const statusOf = (answer: SpeechModelAnswer): SpeechStatus => {
  if (answer.ok) return answer.status;
  const { _tag, ...fields } = answer.error;
  throw _tag === "SpeechRefused"
    ? new SpeechRefused(fields as Omit<Extract<typeof answer.error, { _tag: typeof _tag }>, "_tag">)
    : new FsError(fields as { path: string; message: string });
};

const unavailable = (model: SpeechModelId) =>
  new SpeechRefused({
    model,
    reason: "unavailable",
    message: "Local dictation runs in the Gram app, which keeps its models.",
  });

/**
 * The model store's half of `SpeechApi`, over the shell's `speech.models`. With
 * no shell, every call rejects with `SpeechRefused` (`unavailable`).
 */
export const speechModelsBridge = (models: () => SpeechModels | undefined): ModelsApi => {
  const call = async (
    model: SpeechModelId,
    run: (store: SpeechModels) => Promise<SpeechModelAnswer>,
  ): Promise<SpeechStatus> => {
    const store = models();
    if (store === undefined) throw unavailable(model);
    return statusOf(await run(store));
  };
  return {
    speechStatus: (model) => call(model, (store) => store.status(model)),
    installSpeechModel: (model) => call(model, (store) => store.install(model)),
    cancelSpeechInstall: (model) => call(model, (store) => store.cancel(model)),
    removeSpeechModel: (model) => call(model, (store) => store.remove(model)),
    watchSpeechInstall: (model, signal) => ({
      [Symbol.asyncIterator]: async function* () {
        const store = models();
        if (store === undefined) throw unavailable(model);
        // Only the latest status matters: each answer is the whole status.
        let latest: SpeechModelAnswer | undefined;
        let wake: (() => void) | undefined;
        const unwatch = store.watch(model, (answer) => {
          latest = answer;
          wake?.();
        });
        const onAbort = () => wake?.();
        signal.addEventListener("abort", onAbort);
        try {
          while (!signal.aborted) {
            if (latest === undefined) {
              await new Promise<void>((resolve) => (wake = resolve));
              wake = undefined;
              continue;
            }
            const answer: SpeechModelAnswer = latest;
            latest = undefined;
            yield statusOf(answer);
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          unwatch();
        }
      },
    }),
  };
};

/** `speechModelsBridge` over this window's shell. */
export const shellSpeechModels = (): ModelsApi =>
  speechModelsBridge(() => window.gram?.speech?.models);
