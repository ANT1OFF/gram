import * as Schema from "effect/Schema";

import { Sha256Hex } from "./agent-runtime.ts";
import type { SpeechPerformance } from "./speech-bridge.ts";

/**
 * Local voice input's speech models: the pinned manifest the app carries for each one, and the
 * server's store that downloads, verifies and installs it under `<dataDir>/speech`. Recognition
 * itself runs in the desktop shell's speech process (`speech-bridge.ts`); audio and transcripts
 * never cross these RPCs.
 */

/**
 * One path segment under `<dataDir>/speech/models`: lowercase letters, digits, `.`, `_` and `-`,
 * not starting with a dot, so an id can never name another directory.
 */
export const SpeechModelId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/),
).pipe(Schema.brand("SpeechModelId"));
export type SpeechModelId = typeof SpeechModelId.Type;

/** The model voice input uses when the user picked none: the Balanced stop's. */
export const DEFAULT_SPEECH_MODEL = SpeechModelId.make("nemotron-speech-en-0.6b-560ms-int8");

/** The performance slider's stops, as Settings stores them; `SPEECH_PERFORMANCE_STOPS` runs them. */
export const SpeechPerformanceStop = Schema.Literals(["responsive", "balanced", "efficient"]);
export type SpeechPerformanceStop = typeof SpeechPerformanceStop.Type;

/**
 * The model each stop runs: the same English model exported for that stop's streaming chunk, so
 * moving the slider to a stop whose variant isn't installed means another download.
 */
export const SPEECH_MODEL_FOR_STOP: Readonly<Record<SpeechPerformance, SpeechModelId>> = {
  responsive: SpeechModelId.make("nemotron-speech-en-0.6b-160ms-int8"),
  balanced: DEFAULT_SPEECH_MODEL,
  efficient: SpeechModelId.make("nemotron-speech-en-0.6b-1120ms-int8"),
};

/** A file's relative path inside a model directory: no `..`, no absolute path, no backslash. */
const ModelPath = Schema.String.check(
  Schema.isPattern(/^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
);

/** One file of a model, checked byte for byte before the model is installed. */
export const SpeechModelFile = Schema.Struct({
  path: ModelPath,
  /** Exact byte length. */
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Sha256Hex,
});
export type SpeechModelFile = typeof SpeechModelFile.Type;

/** What the user agrees to before downloading, shown as Settings words it. */
export const SpeechModelLicense = Schema.Struct({
  /** `nvidia-open-model-license`, `openmdw-1.1`. */
  id: Schema.String,
  /** "NVIDIA Open Model License". */
  name: Schema.String,
  url: Schema.String,
  /** The notice the licence requires wherever the model is shown or stored. */
  attribution: Schema.String,
});
export type SpeechModelLicense = typeof SpeechModelLicense.Type;

/** The upstream checkpoint the files were exported from, which EXAMPLE's CI re-exports to audit them. */
export const SpeechModelSource = Schema.Struct({
  /** The Hugging Face repo id, `nvidia/nemotron-speech-streaming-en-0.6b`. */
  repo: Schema.String,
  /** The pinned commit of that repo. */
  revision: Schema.String,
  /** SHA-256 of the checkpoint the export read. */
  sha256: Schema.optionalKey(Sha256Hex),
});
export type SpeechModelSource = typeof SpeechModelSource.Type;

/** A Hugging Face repo id, `<owner>/<name>`. */
const HfRepo = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

/** The files of `files` the speech process loads, by role. */
export const SpeechRecognizer = Schema.Struct({
  kind: Schema.Literal("sherpa-onnx-online-transducer"),
  encoder: ModelPath,
  decoder: ModelPath,
  joiner: ModelPath,
  tokens: ModelPath,
  /** The streaming chunk the encoder was exported for, which the recogniser flushes on stop. */
  chunkMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SpeechRecognizer = typeof SpeechRecognizer.Type;

/** What was checked about a model's files, and how it came out. */
const SpeechModelEvidence = Schema.Struct({
  /** What was checked: a reproduced export, the upstream digests. */
  kind: Schema.String,
  /** `verified`; `absent` (looked for, not published); `unverified` (published, not checked). */
  status: Schema.String,
  detail: Schema.String,
});

/**
 * One speech model as this app version pins it: exact files at an exact revision of a Hugging Face
 * repo, fetched as `{base}/{repo}/resolve/{revision}/{path}` from whichever base the server is
 * configured for, so the host never changes what is accepted. Model updates ship with app releases
 * under a new `id`, so a manifest never changes once released. The store writes it, with
 * `verifiedAt`, as the installed model's `verified.json`.
 */
export const SpeechModelManifest = Schema.Struct({
  id: SpeechModelId,
  /** "Nemotron Speech Streaming EN 0.6B". */
  name: Schema.String,
  /** BCP 47 codes it transcribes, `["en"]`. */
  languages: Schema.Array(Schema.String),
  license: SpeechModelLicense,
  source: SpeechModelSource,
  repo: HfRepo,
  /** The repo's full commit hash, never a branch. */
  revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  /** Every file the model is; each is downloaded, sized and hashed. */
  files: Schema.Array(SpeechModelFile),
  recognizer: SpeechRecognizer,
  /** About how much memory the speech process uses while the model is loaded. */
  memoryBytes: Schema.Int,
  /** How the files were checked: EXAMPLE's reproduced export, the upstream digests. */
  evidence: Schema.Array(SpeechModelEvidence),
});
export type SpeechModelManifest = typeof SpeechModelManifest.Type;

/** The bytes a model's files add up to. */
export const speechModelBytes = (manifest: SpeechModelManifest): number =>
  manifest.files.reduce((total, file) => total + file.size, 0);

/** `verified.json` in an installed model's directory: what was checked, and when. */
export const SpeechVerifiedModel = Schema.Struct({
  ...SpeechModelManifest.fields,
  /** Epoch ms. */
  verifiedAt: Schema.Number,
});
export type SpeechVerifiedModel = typeof SpeechVerifiedModel.Type;

/** A model in the store, verified when it was installed. */
export const SpeechInstalledModel = Schema.Struct({
  id: SpeechModelId,
  /** Bytes on disk. */
  sizeBytes: Schema.Number,
  /** Epoch ms it was verified and moved into place. */
  installedAt: Schema.Number,
});
export type SpeechInstalledModel = typeof SpeechInstalledModel.Type;

/**
 * Why an install stopped, for Settings to say what to do: `network` (unreachable, timed out, cut
 * off), `proxy` (a proxy or the firewall refused it; the message names the hosts to allow), `http`
 * (the host answered with an error), `verification` (a size or hash didn't match, so nothing was
 * kept), `disk-space` (not enough free before or during the download), `filesystem` (the data
 * folder couldn't be written).
 */
export const SpeechInstallFailure = Schema.Literals([
  "network",
  "proxy",
  "http",
  "verification",
  "disk-space",
  "filesystem",
]);
export type SpeechInstallFailure = typeof SpeechInstallFailure.Type;

/** A model's install, from idle through the download to its outcome. */
export const SpeechInstallState = Schema.Union([
  /** Nothing under way; a cancelled or interrupted download resumes from `resumableBytes`. */
  Schema.Struct({
    state: Schema.Literal("idle"),
    resumableBytes: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    state: Schema.Literal("downloading"),
    receivedBytes: Schema.Number,
    totalBytes: Schema.Number,
  }),
  /** Downloaded and hashed; now unpacking and checking every file. */
  Schema.Struct({ state: Schema.Literal("verifying") }),
  /** The install stopped; whatever was installed before is untouched. */
  Schema.Struct({
    state: Schema.Literal("failed"),
    reason: SpeechInstallFailure,
    message: Schema.String,
    resumableBytes: Schema.optionalKey(Schema.Number),
  }),
]);
export type SpeechInstallState = typeof SpeechInstallState.Type;

/** `speech.status` and each `speech.watchInstall` update, for one model. */
export const SpeechStatus = Schema.Struct({
  model: SpeechModelManifest,
  /** Present once the model is verified and in place. */
  installed: Schema.optionalKey(SpeechInstalledModel),
  install: SpeechInstallState,
  /** Free bytes where the model would go; absent when the disk couldn't be asked. */
  freeBytes: Schema.optionalKey(Schema.Number),
});
export type SpeechStatus = typeof SpeechStatus.Type;

/** Why the store wouldn't act on a model. */
export const SpeechRefusal = Schema.Literals([
  /** This app version pins no model by that id. */
  "unknown-model",
  /** An install of it is under way. */
  "busy",
  /** No shell keeps models here: a browser, or a shell without the model store. */
  "unavailable",
]);
export type SpeechRefusal = typeof SpeechRefusal.Type;

export class SpeechRefused extends Schema.TaggedError<SpeechRefused>()("SpeechRefused", {
  model: Schema.String,
  reason: SpeechRefusal,
  message: Schema.String,
}) {}
