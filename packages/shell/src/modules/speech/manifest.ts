// The speech models this app version pins. Each is exact files at an exact Hugging Face commit; a
// model update ships with an app release, under a new id, and nothing here is ever "latest". What
// the store enforces is identity: every file's size and sha256. Equivalence to NVIDIA's checkpoint
// is for CI to hold: a reproduce job (not in this repo yet) re-exports each model from the pinned
// `.nemo` and is to fail unless every file's sha256 equals the one pinned here.

import {
  SPEECH_MODEL_FOR_STOP,
  type SpeechModelLicense,
  type SpeechModelManifest,
} from "@gram/contracts";

/** Where model files come from unless `GRAM_HF_BASE` names a mirror, such as npm registry's. */
export const DEFAULT_HF_BASE = "https://huggingface.co";

const NVIDIA_OPEN_MODEL_LICENSE: SpeechModelLicense = {
  id: "nvidia-open-model-license",
  name: "NVIDIA Open Model License",
  url: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
  attribution: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License",
};

/** The decoder, joiner and tokens every chunk size shares, byte for byte. */
const SHARED_FILES = [
  {
    path: "decoder.int8.onnx",
    size: 7_257_753,
    sha256: "0be9702c2f427a2b6bb241d298e0d3836a558de1f5b9fd3018f1cce6e2b3fa98",
  },
  {
    path: "joiner.int8.onnx",
    size: 1_735_862,
    sha256: "a35eac38a22ebceb04d230ed7afe0d68f446ba6914a036b97f14fece95967e23",
  },
  {
    path: "tokens.txt",
    size: 8_952,
    sha256: "dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff",
  },
] as const;

/**
 * Nemotron Speech Streaming EN 0.6B as sherpa-onnx's maintainer exported it to int8 for one
 * streaming chunk; only the encoder differs between chunk sizes.
 */
const nemotronEnglish = (
  chunkMs: 160 | 560 | 1120,
  revision: string,
  encoder: { readonly size: number; readonly sha256: string },
): SpeechModelManifest => ({
  id: SPEECH_MODEL_FOR_STOP[
    chunkMs === 160 ? "responsive" : chunkMs === 560 ? "balanced" : "efficient"
  ],
  name: "Nemotron Speech Streaming EN 0.6B",
  languages: ["en"],
  license: NVIDIA_OPEN_MODEL_LICENSE,
  source: {
    repo: "nvidia/nemotron-speech-streaming-en-0.6b",
    revision: "ebe59e5a817142986528bbbee5dba8db7b38ed50",
    sha256: "283638054c44f6794e74fe9af9048d78a6d9d6c058c12131856c7859a62ac9cd",
  },
  repo: `csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-${chunkMs}ms-int8-2026-04-25`,
  revision,
  files: [{ path: "encoder.int8.onnx", ...encoder }, ...SHARED_FILES],
  recognizer: {
    kind: "sherpa-onnx-online-transducer",
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
    chunkMs,
  },
  memoryBytes: 1_300_000_000,
  evidence: [
    {
      kind: "hf-lfs-sha256",
      status: "verified",
      detail: "Each file's sha256 equals the LFS digest Hugging Face serves at the revision.",
    },
  ],
});

/** One per performance stop, Balanced first. */
export const SPEECH_MODELS: ReadonlyArray<SpeechModelManifest> = [
  nemotronEnglish(560, "52056fdc070914a48dcd68b31b44d6a6f5b85902", {
    size: 652_916_849,
    sha256: "7d932213491ad355c6e5576705dc3494731a52af87d7a1b954559340147909d8",
  }),
  nemotronEnglish(160, "237e551abd7a411ef92d3595454d9f6ab5fe7d6c", {
    size: 652_916_849,
    sha256: "71111f61b18e1e65e01e369434a5c0434868d2f44892742ae54240600c681209",
  }),
  nemotronEnglish(1120, "b0b6bae3da99ea3d81b315ba018e951501850c2c", {
    size: 652_916_852,
    sha256: "7d2246da3c077e8b57698d398e09d8ca67f50de73b3468af397b22213ce72117",
  }),
];

export const speechManifest = (id: string): SpeechModelManifest | undefined =>
  SPEECH_MODELS.find((model) => model.id === id);
