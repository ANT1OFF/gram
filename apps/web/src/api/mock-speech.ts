import {
  DEFAULT_SPEECH_MODEL,
  SPEECH_MODEL_FOR_STOP,
  SpeechRefused,
  speechModelBytes,
  type SpeechInstallFailure,
  type SpeechInstalledModel,
  type SpeechInstallState,
  type SpeechModelId,
  type SpeechModelManifest,
  type SpeechStatus,
} from "@gram/contracts";

import { createChannel, type Channel } from "./channel";

const SHA = "0".repeat(64);

const variant = (id: SpeechModelId, chunkMs: number): SpeechModelManifest => ({
  id,
  name: "Nemotron Speech Streaming EN 0.6B",
  languages: ["en"],
  license: {
    id: "nvidia-open-model-license",
    name: "NVIDIA Open Model License",
    url: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
    attribution: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License",
  },
  source: {
    repo: "nvidia/nemotron-speech-streaming-en-0.6b",
    revision: "ebe59e5a817142986528bbbee5dba8db7b38ed50",
  },
  repo: `csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-${chunkMs}ms-int8-2026-04-25`,
  revision: "52056fdc070914a48dcd68b31b44d6a6f5b85902",
  files: [
    { path: "encoder.int8.onnx", size: 652_916_849, sha256: SHA },
    { path: "decoder.int8.onnx", size: 7_257_753, sha256: SHA },
    { path: "joiner.int8.onnx", size: 1_735_862, sha256: SHA },
    { path: "tokens.txt", size: 8_952, sha256: SHA },
  ],
  recognizer: {
    kind: "sherpa-onnx-online-transducer",
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
    chunkMs,
  },
  memoryBytes: 1_300_000_000,
  evidence: [],
});

/** Every model a release pins, one per performance stop, with stand-in digests. */
export const MOCK_SPEECH_MODELS: readonly SpeechModelManifest[] = [
  variant(SPEECH_MODEL_FOR_STOP.balanced, 560),
  variant(SPEECH_MODEL_FOR_STOP.responsive, 160),
  variant(SPEECH_MODEL_FOR_STOP.efficient, 1120),
];

/** The default model's manifest. */
export const MOCK_SPEECH_MANIFEST = MOCK_SPEECH_MODELS[0]!;

const STEPS = [0, 0.25, 0.5, 0.75, 1];

interface ModelState {
  install: SpeechInstallState;
  installed: SpeechInstalledModel | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The speech model store, downloading in a few quick steps. Specs reach it through
 * `window.gramMock.speech` to fail the next install, slow it down or start installed.
 */
export class MockSpeechStore {
  readonly #models = new Map<string, ModelState>(
    MOCK_SPEECH_MODELS.map((model) => [
      model.id,
      { install: { state: "idle" }, installed: undefined, timer: undefined },
    ]),
  );
  readonly #watchers = new Map<string, Set<Channel<SpeechStatus>>>();
  /** Milliseconds between progress steps. */
  stepMs = 150;
  /** Free disk space reported, in bytes. */
  freeBytes = 120_000_000_000;
  /** Set by a spec: the next install fails this way halfway through the download. */
  failNext: { readonly reason: SpeechInstallFailure; readonly message: string } | undefined;

  /** Marks a model installed, as a returning user would have it. */
  preinstall(model: SpeechModelId = DEFAULT_SPEECH_MODEL): void {
    const state = this.#models.get(model)!;
    state.installed = {
      id: model,
      sizeBytes: speechModelBytes(this.#manifest(model)),
      installedAt: Date.now(),
    };
    this.#emit(model);
  }

  #manifest(model: string): SpeechModelManifest {
    return MOCK_SPEECH_MODELS.find((manifest) => manifest.id === model)!;
  }

  #known(model: SpeechModelId): ModelState {
    const state = this.#models.get(model);
    if (state === undefined)
      throw new SpeechRefused({
        model,
        reason: "unknown-model",
        message: "This version of Gram doesn't know that speech model.",
      });
    return state;
  }

  #status(model: string): SpeechStatus {
    const state = this.#models.get(model)!;
    return {
      model: this.#manifest(model),
      ...(state.installed === undefined ? {} : { installed: state.installed }),
      install: state.install,
      freeBytes: this.freeBytes,
    };
  }

  #emit(model: string): SpeechStatus {
    const status = this.#status(model);
    for (const watcher of this.#watchers.get(model) ?? []) watcher.push(status);
    return status;
  }

  #set(model: string, install: SpeechInstallState): SpeechStatus {
    this.#models.get(model)!.install = install;
    return this.#emit(model);
  }

  async status(model: SpeechModelId): Promise<SpeechStatus> {
    this.#known(model);
    return this.#status(model);
  }

  watch(model: SpeechModelId, signal: AbortSignal): AsyncIterable<SpeechStatus> {
    this.#known(model);
    // `createChannel` closes an already-aborted one at once, before `channel` below is bound.
    if (signal.aborted) return createChannel<SpeechStatus>(signal);
    const watchers = this.#watchers.get(model) ?? new Set();
    this.#watchers.set(model, watchers);
    const channel = createChannel<SpeechStatus>(signal, () => {
      watchers.delete(channel);
    });
    watchers.add(channel);
    channel.push(this.#status(model));
    return channel;
  }

  async install(model: SpeechModelId): Promise<SpeechStatus> {
    const state = this.#known(model);
    if (state.timer !== undefined)
      throw new SpeechRefused({ model, reason: "busy", message: "Already downloading." });
    const total = speechModelBytes(this.#manifest(model));
    const failure = this.failNext;
    this.failNext = undefined;
    // A cancelled or failed download resumes from what it kept, as the real store does.
    const kept =
      state.install.state === "idle" || state.install.state === "failed"
        ? (state.install.resumableBytes ?? 0)
        : 0;
    const step = (index: number) => {
      const receivedBytes = Math.round(kept + (total - kept) * STEPS[index]!);
      if (failure !== undefined && index === 2) {
        state.timer = undefined;
        this.#set(model, {
          state: "failed",
          ...failure,
          ...(failure.reason === "verification" ? {} : { resumableBytes: receivedBytes }),
        });
        return;
      }
      if (index < STEPS.length) {
        this.#set(model, { state: "downloading", receivedBytes, totalBytes: total });
        state.timer = setTimeout(() => step(index + 1), this.stepMs);
        return;
      }
      this.#set(model, { state: "verifying" });
      state.timer = setTimeout(() => {
        state.timer = undefined;
        state.installed = { id: model, sizeBytes: total, installedAt: Date.now() };
        this.#set(model, { state: "idle" });
        // As the real store does: every pinned model is a variant of one, and one stays on disk.
        for (const [other, each] of this.#models)
          if (other !== model && each.installed !== undefined && each.timer === undefined) {
            each.installed = undefined;
            this.#emit(other);
          }
      }, this.stepMs);
    };
    step(0);
    return this.#status(model);
  }

  async cancel(model: SpeechModelId): Promise<SpeechStatus> {
    const state = this.#known(model);
    clearTimeout(state.timer);
    state.timer = undefined;
    const install = state.install;
    if (install.state === "downloading")
      return this.#set(model, { state: "idle", resumableBytes: install.receivedBytes });
    if (install.state === "failed")
      return this.#set(
        model,
        install.resumableBytes === undefined
          ? { state: "idle" }
          : { state: "idle", resumableBytes: install.resumableBytes },
      );
    return install.state === "verifying"
      ? this.#set(model, { state: "idle" })
      : this.#status(model);
  }

  async remove(model: SpeechModelId): Promise<SpeechStatus> {
    const state = this.#known(model);
    if (state.timer !== undefined)
      throw new SpeechRefused({ model, reason: "busy", message: "A download is under way." });
    state.installed = undefined;
    return this.#set(model, { state: "idle" });
  }
}
