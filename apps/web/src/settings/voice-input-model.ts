import {
  SpeechRefused,
  SPEECH_MODEL_FOR_STOP,
  speechModelBytes,
  type SpeechInstallFailure,
  type SpeechModelId,
  type SpeechPerformance,
  type SpeechStatus,
} from "@gram/contracts";

/** The slider's stops, left to right. */
export const STOPS: readonly SpeechPerformance[] = ["responsive", "balanced", "efficient"];

export const STOP_LABELS: Readonly<Record<SpeechPerformance, string>> = {
  responsive: "Responsive",
  balanced: "Balanced",
  efficient: "Efficient",
};

/**
 * What each stop costs and gives, from the measurements on an M4 Pro: how often text appears, and
 * how much of one CPU core the speech process uses while dictating. Word errors were about 10 % at
 * every stop, so none of them promises better accuracy.
 */
export const STOP_HELP: Readonly<Record<SpeechPerformance, string>> = {
  responsive: "Text about every 0.2 s, using roughly two-thirds of one core.",
  balanced: "Text about every 0.6 s, using about a quarter of one core.",
  efficient: "Text about every 1.2 s, using about an eighth of one core.",
};

export const LOCAL_HINTS_HELP =
  "The local NVIDIA Nemotron model recognises English. Audio and transcripts stay on this computer; vocabulary hints are not supported.";

/** `bytes` the way Finder rounds them: decimal units, one decimal place from a gigabyte up. */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
};

/** A failed install's heading; the store's message under it says what to do. */
export const FAILURE_TITLES: Readonly<Record<SpeechInstallFailure, string>> = {
  network: "The download stopped",
  proxy: "A proxy or firewall blocked the download",
  http: "The model host refused the download",
  verification: "The download didn't verify, so nothing was kept",
  "disk-space": "Not enough disk space",
  filesystem: "Couldn't write the model to disk",
};

/** The stop whose model is `id`. */
export const stopOf = (id: SpeechModelId): SpeechPerformance =>
  STOPS.find((stop) => SPEECH_MODEL_FOR_STOP[stop] === id) ?? "balanced";

/** Bytes on disk across every installed variant: what turning voice input off frees. */
export const installedBytes = (statuses: readonly (SpeechStatus | undefined)[]): number =>
  statuses.reduce((sum, status) => sum + (status?.installed?.sizeBytes ?? 0), 0);

/** What one model's row says about its download. */
export type ModelProgress =
  | { readonly kind: "ready"; readonly sizeBytes: number }
  | { readonly kind: "downloading"; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: "verifying" }
  | { readonly kind: "paused"; readonly receivedBytes: number; readonly totalBytes: number }
  | {
      readonly kind: "failed";
      readonly reason: SpeechInstallFailure;
      readonly message: string;
      readonly resumable: boolean;
    }
  | { readonly kind: "absent"; readonly totalBytes: number };

export const progressOf = (status: SpeechStatus): ModelProgress => {
  const total = speechModelBytes(status.model);
  const { install } = status;
  switch (install.state) {
    case "downloading":
      return {
        kind: "downloading",
        receivedBytes: install.receivedBytes,
        totalBytes: install.totalBytes || total,
      };
    case "verifying":
      return { kind: "verifying" };
    case "failed":
      return {
        kind: "failed",
        reason: install.reason,
        message: install.message,
        resumable: (install.resumableBytes ?? 0) > 0,
      };
    case "idle":
      if (status.installed !== undefined)
        return { kind: "ready", sizeBytes: status.installed.sizeBytes };
      return (install.resumableBytes ?? 0) > 0
        ? { kind: "paused", receivedBytes: install.resumableBytes ?? 0, totalBytes: total }
        : { kind: "absent", totalBytes: total };
  }
};

/**
 * Cancels and deletes each of `models`, for turning voice input off. With no shell to keep them
 * there are none to delete, and its `unavailable` refusal mustn't stop the setting going off.
 */
export const removeModels = async (
  api: {
    readonly cancelSpeechInstall: (model: SpeechModelId) => Promise<unknown>;
    readonly removeSpeechModel: (model: SpeechModelId) => Promise<unknown>;
  },
  models: readonly SpeechModelId[],
): Promise<void> => {
  try {
    for (const id of models) {
      await api.cancelSpeechInstall(id);
      await api.removeSpeechModel(id);
    }
  } catch (error) {
    if (!(error instanceof SpeechRefused && error.reason === "unavailable")) throw error;
  }
};
