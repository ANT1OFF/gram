import type { SpeechModelId, SpeechStatus } from "@gram/contracts";

/** Local dictation model storage in the desktop shell; no remote audio API. */
export interface SpeechApi {
  /**
   * A speech model's pinned manifest, whether it is installed and any install under way. Rejects
   * with `SpeechRefused` for a model this app version doesn't pin, or with no shell to keep it.
   */
  speechStatus(model: SpeechModelId): Promise<SpeechStatus>;
  /** `speechStatus` now and on each change, download progress included, until `signal` aborts. */
  watchSpeechInstall(model: SpeechModelId, signal: AbortSignal): AsyncIterable<SpeechStatus>;
  /**
   * Starts downloading, verifying and installing the model, resuming a partial download; failures
   * arrive as the `failed` install state. Rejects with `SpeechRefused` while one is under way.
   */
  installSpeechModel(model: SpeechModelId): Promise<SpeechStatus>;
  /** Stops a download, keeping what arrived for the next install to resume from. */
  cancelSpeechInstall(model: SpeechModelId): Promise<SpeechStatus>;
  /** Deletes the installed model and any partial download of it. */
  removeSpeechModel(model: SpeechModelId): Promise<SpeechStatus>;
}
