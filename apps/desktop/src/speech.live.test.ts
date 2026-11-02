import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SpeechServerMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  createSpeechService,
  loadSherpaRuntime,
  type SessionPort,
} from "@gram/shell/speech-process";

// GRAM_LIVE_SPEECH=1 GRAM_LIVE_SPEECH_MODEL=<an unpacked sherpa-onnx Nemotron streaming export>
// [GRAM_LIVE_SPEECH_WAV=<16 kHz mono 16-bit WAV>, default the export's test_wavs/0.wav]
// [GRAM_LIVE_SPEECH_CHUNK_MS=<the export's chunk>, default 560]
// [GRAM_LIVE_SPEECH_ACCURATE=<an unpacked sherpa-onnx Parakeet TDT int8 export>
//  GRAM_LIVE_SPEECH_VAD=<silero_vad_v5.onnx>, to run accurate mode's pass over each utterance too]
const MODEL = process.env["GRAM_LIVE_SPEECH_MODEL"] ?? "";
const ACCURATE = process.env["GRAM_LIVE_SPEECH_ACCURATE"] ?? "";
const VAD = process.env["GRAM_LIVE_SPEECH_VAD"] ?? "";
const WAV = process.env["GRAM_LIVE_SPEECH_WAV"] ?? join(MODEL, "test_wavs", "0.wav");

/** The samples of a 16-bit PCM WAV, as floats in [-1, 1]. */
function readWav(file: string): Float32Array {
  const bytes = readFileSync(file);
  let at = 12;
  while (at < bytes.length - 8) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "data") {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++)
        samples[i] = bytes.readInt16LE(at + 8 + i * 2) / 32768;
      return samples;
    }
    at += 8 + size;
  }
  throw new Error(`no data chunk in ${file}`);
}

/** A session on the real runtime, fed `samples` in 100 ms frames, then `stop`. */
const dictate = async (samples: Float32Array, accurate: boolean) => {
  const sent: SpeechServerMessage[] = [];
  const listeners: { message?: (event: { data: unknown }) => void } = {};
  const closed = Promise.withResolvers<void>();
  const port: SessionPort = {
    postMessage: (message) => sent.push(message),
    on: ((event: "message" | "close", listener: never) => {
      if (event === "message") listeners.message = listener;
    }) as SessionPort["on"],
    start: () => {},
    close: () => closed.resolve(),
  };
  const logs: string[] = [];
  const service = createSpeechService({
    loadRuntime: () => loadSherpaRuntime(import.meta.url),
    send: () => {},
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    now: () => performance.now(),
    exit: () => {},
  });
  const model = {
    encoder: join(MODEL, "encoder.int8.onnx"),
    decoder: join(MODEL, "decoder.int8.onnx"),
    joiner: join(MODEL, "joiner.int8.onnx"),
    tokens: join(MODEL, "tokens.txt"),
    chunkMs: Number(process.env["GRAM_LIVE_SPEECH_CHUNK_MS"] ?? 560),
  };
  const passPaths = {
    encoder: join(ACCURATE, "encoder.int8.onnx"),
    decoder: join(ACCURATE, "decoder.int8.onnx"),
    joiner: join(ACCURATE, "joiner.int8.onnx"),
    tokens: join(ACCURATE, "tokens.txt"),
    vad: VAD,
  };
  // Loaded ahead, as a prewarm on composer focus does, so the first utterance needn't wait for it.
  if (accurate)
    service.receive({ type: "prewarm", requestId: 1, model, threads: 2, accurate: passPaths }, []);
  service.receive(
    {
      type: "open",
      sessionId: "live",
      threads: 2,
      model,
      ...(accurate ? { accurate: passPaths } : {}),
    },
    [port],
  );
  expect(sent[0]).toMatchObject({ type: "ready" });
  for (let at = 0; at < samples.length; at += 1_600) {
    listeners.message?.({ data: { type: "audio", samples: samples.slice(at, at + 1_600) } });
  }
  listeners.message?.({ data: { type: "stop" } });
  await closed.promise;
  return { sent, logs };
};

describe.skipIf(process.env["GRAM_LIVE_SPEECH"] !== "1" || ACCURATE === "" || VAD === "")(
  "speech, live, accurate mode (GRAM_LIVE_SPEECH_ACCURATE, GRAM_LIVE_SPEECH_VAD)",
  () => {
    it(
      "commits the offline model's punctuated text, and nothing for silence",
      { timeout: 180_000 },
      async () => {
        const speech = readWav(WAV);
        const pause = new Float32Array(2 * 16_000);
        const quiet = new Float32Array(3 * 16_000);
        for (let i = 0; i < quiet.length; i++) quiet[i] = (Math.random() - 0.5) * 0.002;
        const clip = new Float32Array(speech.length + pause.length + quiet.length);
        clip.set(speech);
        clip.set(quiet, speech.length + pause.length);
        const { sent, logs } = await dictate(clip, true);
        const finals = sent.flatMap((message) => (message.type === "final" ? [message] : []));
        expect(sent.some((message) => message.type === "partial")).toBe(true);
        expect(finals[0]).toMatchObject({ reason: "endpoint" });
        expect(finals[0]!.text.toLowerCase()).toContain("yellow lamps");
        // Parakeet capitalises and punctuates; the stream does neither.
        expect(finals[0]!.text).toMatch(/^[A-Z].*[.?!]$/);
        // Three seconds of room noise and the stop: one empty last final, no words.
        expect(finals.slice(1)).toEqual([{ type: "final", text: "", reason: "stop" }]);
        expect(logs.some((line) => line.startsWith("accurate pass {"))).toBe(true);
        expect(logs.join("\n")).not.toMatch(/yellow/i);
      },
    );
  },
);

describe.skipIf(process.env["GRAM_LIVE_SPEECH"] !== "1")(
  "speech, live (GRAM_LIVE_SPEECH=1)",
  () => {
    it(
      "transcribes a WAV streamed in 100 ms frames through the real recogniser",
      { timeout: 120_000 },
      () => {
        const sent: SpeechServerMessage[] = [];
        const listeners: { message?: (event: { data: unknown }) => void } = {};
        const port: SessionPort = {
          postMessage: (message) => sent.push(message),
          on: ((event: "message" | "close", listener: never) => {
            if (event === "message") listeners.message = listener;
          }) as SessionPort["on"],
          start: () => {},
          close: () => {},
        };
        const service = createSpeechService({
          loadRuntime: () => loadSherpaRuntime(import.meta.url),
          send: () => {},
          log: () => {},
          now: () => performance.now(),
          exit: () => {},
        });
        service.receive(
          {
            type: "open",
            sessionId: "live",
            threads: 2,
            model: {
              encoder: join(MODEL, "encoder.int8.onnx"),
              decoder: join(MODEL, "decoder.int8.onnx"),
              joiner: join(MODEL, "joiner.int8.onnx"),
              tokens: join(MODEL, "tokens.txt"),
              chunkMs: Number(process.env["GRAM_LIVE_SPEECH_CHUNK_MS"] ?? 560),
            },
          },
          [port],
        );
        expect(sent[0]).toMatchObject({ type: "ready" });
        const samples = readWav(WAV);
        for (let at = 0; at < samples.length; at += 1_600) {
          listeners.message?.({ data: { type: "audio", samples: samples.slice(at, at + 1_600) } });
        }
        listeners.message?.({ data: { type: "stop" } });

        expect(sent.some((message) => message.type === "partial")).toBe(true);
        const text = sent
          .flatMap((message) => (message.type === "final" ? [message.text] : []))
          .join(" ")
          .toLowerCase();
        expect(sent.at(-1)).toMatchObject({ type: "final", reason: "stop" });
        expect(text).toContain("yellow lamps");
      },
    );
  },
);
