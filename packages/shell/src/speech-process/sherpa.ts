import { createRequire } from "node:module";
import { dirname, posix, win32 } from "node:path";

import type * as Sherpa from "sherpa-onnx-node";

import type { SpeechSegment } from "./accurate.ts";
import type { SpeechAccuratePaths, SpeechModelPaths } from "./protocol.ts";
import type { AccuratePass, Recogniser, SpeechRuntime } from "./service.ts";

/**
 * ONNX Runtime threads for the offline model, whatever the slider's stop: on an M5 Pro a 5 s clip
 * took 730 ms on one thread, 220 ms on two, and no less on four or six.
 */
const OFFLINE_THREADS = 2;

/** The detector's window, Silero v5's for 16 kHz audio, and its own buffer of what it heard. */
const VAD_WINDOW_SAMPLES = 512;
const VAD_BUFFER_SECONDS = 60;

/** ONNX Runtime's library, by the names it ships under on each platform. */
const ONNX_RUNTIME = /(?:^|[\\/])(?:lib)?onnxruntime(?:\.[\d.]+)?\.(?:dll|dylib|so(?:\.[\d.]+)?)$/i;

/**
 * A Windows path without its extended-length prefix, which is how Windows reports a loaded module:
 * `\\?\D:\x` → `D:\x`, `\\?\UNC\host\x` → `\\host\x`.
 */
const withoutLongPathPrefix = (p: string): string =>
  p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");

/**
 * The ONNX Runtime libraries loaded in this process that aren't the one in `packageDir`. Windows 11
 * ships its own `onnxruntime.dll` in System32 for Windows ML, and DLL search order can hand the
 * addon that one instead of the copy beside it, a known ORT failure mode; this is how it shows.
 */
export const foreignOnnxRuntimes = (
  sharedObjects: readonly string[],
  packageDir: string,
  platform: NodeJS.Platform,
): string[] => {
  const path = platform === "win32" ? win32 : posix;
  const fold = (p: string) =>
    platform === "win32" ? path.normalize(withoutLongPathPrefix(p)).toLowerCase() : p;
  // In a packaged app the package resolves inside `app.asar`, but its libraries load from the
  // unpacked copy beside it, which is the one the loader reports.
  const unpacked = path
    .join(packageDir, path.sep)
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const inside = fold(unpacked);
  return sharedObjects.filter((p) => ONNX_RUNTIME.test(p) && !fold(p).startsWith(inside));
};

const loadedLibraries = (): string[] => {
  const report: unknown = process.report.getReport();
  const parsed: unknown = typeof report === "string" ? JSON.parse(report) : report;
  const shared: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "sharedObjects") : [];
  return Array.isArray(shared) ? shared.filter((s): s is string => typeof s === "string") : [];
};

/**
 * Loads sherpa-onnx's addon and checks that the ONNX Runtime it brought is its own. Throws when the
 * addon or its libraries don't load, or another ONNX Runtime did. The addon is the app's
 * dependency, not this package's, so it resolves from `from`: the app's speech bundle, whose
 * `node_modules` electron-builder packs and the signing scripts sign.
 */
export function loadSherpaRuntime(from: string): SpeechRuntime {
  const require = createRequire(from);
  const entry = require.resolve("sherpa-onnx-node");
  const sherpa = require("sherpa-onnx-node") as typeof Sherpa;
  const platform = process.platform === "win32" ? "win" : process.platform;
  const packageDir = dirname(
    createRequire(entry).resolve(`sherpa-onnx-${platform}-${process.arch}/package.json`),
  );
  const foreign = foreignOnnxRuntimes(loadedLibraries(), packageDir, process.platform);
  if (foreign.length > 0) {
    throw new Error(
      `another ONNX Runtime is loaded in place of sherpa-onnx's: ${foreign.join(", ")}`,
    );
  }

  const loadAccurate = async (paths: SpeechAccuratePaths): Promise<AccuratePass> => {
    const recognizer = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
        tokens: paths.tokens,
        modelType: "nemo_transducer",
        numThreads: OFFLINE_THREADS,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
    });
    const vad = new sherpa.Vad(
      {
        sileroVad: {
          model: paths.vad,
          threshold: 0.5,
          // Short enough to hear the pause between two sentences, which is where a cut goes.
          minSilenceDuration: 0.3,
          minSpeechDuration: 0.15,
          maxSpeechDuration: 30,
          windowSize: VAD_WINDOW_SAMPLES,
        },
        sampleRate: 16_000,
        numThreads: 1,
        debug: 0,
      },
      VAD_BUFFER_SECONDS,
    );
    return {
      segments: (samples) => {
        vad.reset();
        for (let at = 0; at < samples.length; at += VAD_WINDOW_SAMPLES)
          vad.acceptWaveform(samples.subarray(at, at + VAD_WINDOW_SAMPLES));
        vad.flush();
        const segments: SpeechSegment[] = [];
        while (!vad.isEmpty()) {
          const { start, samples: heard } = vad.front(false);
          segments.push({ start, end: start + heard.length });
          vad.pop();
        }
        return segments;
      },
      transcribe: async (samples) => {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: 16_000, samples });
        return (await recognizer.decodeAsync(stream)).text;
      },
    };
  };

  return {
    loadAccurate,
    load: (model: SpeechModelPaths, threads: number): Recogniser => {
      const recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16_000, featureDim: 128 },
        modelConfig: {
          transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
          tokens: model.tokens,
          numThreads: threads,
          provider: "cpu",
          debug: 0,
        },
        // sherpa's defaults: an utterance ends after 1.2 s of silence following speech, 2.4 s of
        // silence with nothing heard, or 20 s of talking.
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
      });
      return {
        createStream: (language) => {
          const stream = recognizer.createStream();
          if (language !== undefined && language !== "") stream.setOption("language", language);
          return {
            accept: (samples) => stream.acceptWaveform({ sampleRate: 16_000, samples }),
            decode: () => {
              while (recognizer.isReady(stream)) recognizer.decode(stream);
              return recognizer.getResult(stream).text;
            },
            isEndpoint: () => recognizer.isEndpoint(stream),
            reset: () => recognizer.reset(stream),
            finish: () => stream.inputFinished(),
          };
        },
      };
    },
  };
}
