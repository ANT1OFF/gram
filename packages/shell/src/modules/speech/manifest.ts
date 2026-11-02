// The speech models this app version pins. Each is exact files at an exact Hugging Face commit; a
// model update ships with an app release, under a new id, and nothing here is ever "latest". What
// the store enforces is identity: every file's size and sha256. Equivalence to NVIDIA's checkpoint
// is for CI to hold: a reproduce job (not in this repo yet) re-exports each model from the pinned
// `.nemo` and is to fail unless every file's sha256 equals the one pinned here.

import {
  SPEECH_ACCURATE_MODEL,
  SPEECH_MODEL_FOR_STOP,
  SPEECH_VAD_MODEL,
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

/** Attribution as CC BY 4.0 asks: who made it, its licence, and that this copy is changed. */
const PARAKEET_LICENSE: SpeechModelLicense = {
  id: "cc-by-4.0",
  name: "Creative Commons Attribution 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
  attribution:
    "Parakeet TDT 0.6B v2 by NVIDIA, licensed under CC BY 4.0; converted to int8 ONNX by the sherpa-onnx project",
};

const SILERO_LICENSE: SpeechModelLicense = {
  id: "mit",
  name: "MIT License",
  url: "https://github.com/snakers4/silero-vad/blob/v5.0/LICENSE",
  attribution: "Silero VAD, copyright (c) 2020-present Silero Team, licensed under the MIT License",
};

const LFS_VERIFIED = {
  kind: "hf-lfs-sha256",
  status: "verified",
  detail: "Each file's sha256 equals the LFS digest Hugging Face serves at the revision.",
} as const;

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
  evidence: [LFS_VERIFIED],
});

/** What `accurate` mode commits text from. Measured beside Nemotron, about 3.0 GB in all. */
const PARAKEET_ENGLISH: SpeechModelManifest = {
  id: SPEECH_ACCURATE_MODEL,
  name: "Parakeet TDT 0.6B v2",
  languages: ["en"],
  license: PARAKEET_LICENSE,
  source: {
    repo: "nvidia/parakeet-tdt-0.6b-v2",
    revision: "ae9ad07059c7c739ffaf932226a8fe64ae2620b0",
    sha256: "d99e39955c9d3d0350d8fb7c75e40c64a2b2eaeb003883d7c941fd2e8747b28c",
  },
  repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
  revision: "1ab9323565ddb038682214b292f588070a538ce2",
  files: [
    {
      path: "encoder.int8.onnx",
      size: 652_184_296,
      sha256: "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab",
    },
    {
      path: "decoder.int8.onnx",
      size: 7_257_753,
      sha256: "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e",
    },
    {
      path: "joiner.int8.onnx",
      size: 1_739_080,
      sha256: "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2",
    },
    {
      path: "tokens.txt",
      size: 9_384,
      sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
    },
  ],
  recognizer: {
    kind: "sherpa-onnx-offline-transducer",
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
  },
  memoryBytes: 1_700_000_000,
  evidence: [LFS_VERIFIED],
};

/** Finds the speech in an utterance. The same file Silero publishes at its v5.0 tag. */
const SILERO_VAD: SpeechModelManifest = {
  id: SPEECH_VAD_MODEL,
  name: "Silero VAD v5",
  languages: [],
  license: SILERO_LICENSE,
  source: {
    repo: "snakers4/silero-vad",
    url: "https://github.com/snakers4/silero-vad",
    revision: "5cd2ba54db059f961e7545d4f211b44f005a6dfb",
    sha256: "6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396",
  },
  repo: "csukuangfj/vad",
  revision: "fba88cd2e921609e7675c3aaf51e0b9b295da4bc",
  files: [
    {
      path: "silero_vad_v5.onnx",
      size: 2_313_101,
      sha256: "6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396",
    },
  ],
  recognizer: { kind: "sherpa-onnx-silero-vad", model: "silero_vad_v5.onnx" },
  memoryBytes: 10_000_000,
  evidence: [
    LFS_VERIFIED,
    {
      kind: "upstream-sha256",
      status: "verified",
      detail: "The file's sha256 equals files/silero_vad.onnx at the upstream tag v5.0.",
    },
  ],
};

/** One per performance stop, Balanced first, then what `accurate` mode adds. */
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
  PARAKEET_ENGLISH,
  SILERO_VAD,
];

export const speechManifest = (id: string): SpeechModelManifest | undefined =>
  SPEECH_MODELS.find((model) => model.id === id);
