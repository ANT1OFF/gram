import type { SpeechServerMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { createUtterance, planClip } from "./accurate.ts";
import type { SpeechAccuratePaths, SpeechModelPaths, SpeechProcessMessage } from "./protocol.ts";
import {
  type AccuratePass,
  createSpeechService,
  type RecogniserStream,
  type SessionPort,
  type SpeechRuntime,
} from "./service.ts";
import { foreignOnnxRuntimes } from "./sherpa.ts";

const MODEL: SpeechModelPaths = {
  encoder: "/m/encoder.int8.onnx",
  decoder: "/m/decoder.int8.onnx",
  joiner: "/m/joiner.int8.onnx",
  tokens: "/m/tokens.txt",
  chunkMs: 560,
};

/**
 * A recogniser that "hears" one word per non-silent frame: a frame whose first sample is 1 adds
 * "word", and a frame of all zeros after speech is an endpoint.
 */
const noAccurate = () => Promise.reject(new Error("no accurate pass in this test"));

const fakeRuntime = (log: string[] = []): SpeechRuntime => ({
  loadAccurate: noAccurate,
  load: (model, threads) => {
    log.push(`load ${model.encoder} ${threads}`);
    return {
      createStream: (language) => {
        log.push(`stream ${language ?? "-"}`);
        let words: string[] = [];
        let endpoint = false;
        let pending: Float32Array[] = [];
        const stream: RecogniserStream = {
          accept: (samples) => pending.push(samples),
          decode: () => {
            for (const samples of pending) {
              if (samples[0] === 1) {
                words.push("word");
                endpoint = false;
              } else if (samples.length === 1_600 && words.length > 0) {
                endpoint = true;
              }
            }
            pending = [];
            return words.join(" ");
          },
          isEndpoint: () => endpoint,
          reset: () => {
            words = [];
            endpoint = false;
          },
          finish: () => log.push("finish"),
        };
        return stream;
      },
    };
  },
});

const fakePort = () => {
  const sent: SpeechServerMessage[] = [];
  const listeners: { message?: (event: { data: unknown }) => void; close?: () => void } = {};
  let closed = false;
  const port: SessionPort = {
    postMessage: (message) => sent.push(message),
    on: ((event: "message" | "close", listener: never) => {
      listeners[event] = listener;
    }) as SessionPort["on"],
    start: () => {},
    close: () => {
      closed = true;
    },
  };
  return {
    port,
    sent,
    send: (data: unknown) => listeners.message?.({ data }),
    remoteClose: () => listeners.close?.(),
    closed: () => closed,
  };
};

const setup = (runtime: () => SpeechRuntime = () => fakeRuntime()) => {
  const toMain: SpeechProcessMessage[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const service = createSpeechService({
    loadRuntime: runtime,
    send: (message) => toMain.push(message),
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    now: () => 0,
    exit: () => exits.push(1),
  });
  const open = (sessionId = "s1", language?: string) => {
    const port = fakePort();
    service.receive(
      { type: "open", sessionId, model: MODEL, threads: 2, ...(language ? { language } : {}) },
      [port.port],
    );
    return port;
  };
  return { service, toMain, logs, open, exits };
};

const speech = () => new Float32Array(1_600).fill(1);
const silence = () => new Float32Array(1_600);

describe("speech service", () => {
  it("streams partials, commits on an endpoint and on stop, then closes", () => {
    const { open, toMain } = setup();
    const port = open();
    expect(port.sent).toEqual([{ type: "ready", loadMs: 0 }]);
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "audio", samples: silence() });
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "stop" });
    expect(port.sent.slice(1)).toEqual([
      { type: "partial", text: "word" },
      { type: "partial", text: "word word" },
      { type: "final", text: "word word", reason: "endpoint" },
      { type: "partial", text: "word" },
      { type: "final", text: "word", reason: "stop" },
    ]);
    expect(port.closed()).toBe(true);
    expect(toMain).toEqual([{ type: "ended", sessionId: "s1" }]);
    port.send({ type: "audio", samples: speech() });
    expect(port.sent).toHaveLength(6);
  });

  it("flushes at least one whole chunk of the model's on stop", () => {
    for (const [chunkMs, samples] of [
      [160, 9_600],
      [560, 10_560],
      [1120, 19_520],
    ] as const) {
      const accepted: number[] = [];
      const runtime = fakeRuntime();
      const { service } = setup(() => ({
        loadAccurate: noAccurate,
        load: (model, threads) => {
          const recogniser = runtime.load(model, threads);
          return {
            createStream: (language) => {
              const stream = recogniser.createStream(language);
              return {
                ...stream,
                accept: (frame) => {
                  accepted.push(frame.length);
                  stream.accept(frame);
                },
              };
            },
          };
        },
      }));
      const port = fakePort();
      service.receive({ type: "open", sessionId: "s", model: { ...MODEL, chunkMs }, threads: 2 }, [
        port.port,
      ]);
      port.send({ type: "stop" });
      expect(accepted.at(-1)).toBe(samples);
    }
  });

  it("keeps the model loaded across sessions and passes the language on", () => {
    const loads: string[] = [];
    const { open } = setup(() => fakeRuntime(loads));
    open("s1").send({ type: "cancel" });
    open("s2", "nb");
    expect(loads).toEqual(["load /m/encoder.int8.onnx 2", "stream -", "stream nb"]);
  });

  it("ends silently on cancel or when the page's port closes", () => {
    const { open, toMain } = setup();
    const cancelled = open("s1");
    cancelled.send({ type: "cancel" });
    const dropped = open("s2");
    dropped.remoteClose();
    expect(cancelled.sent).toEqual([{ type: "ready", loadMs: 0 }]);
    expect(dropped.sent).toEqual([{ type: "ready", loadMs: 0 }]);
    expect(toMain).toEqual([
      { type: "ended", sessionId: "s1" },
      { type: "ended", sessionId: "s2" },
    ]);
  });

  it("ends the open session as stopped on shutdown, then exits", () => {
    const { open, service, exits } = setup();
    const port = open();
    service.receive({ type: "shutdown" }, []);
    expect(port.sent.at(-1)).toMatchObject({ type: "error", code: "stopped" });
    expect(port.closed()).toBe(true);
    expect(exits).toHaveLength(1);
  });

  it("supersedes the open session when another opens", () => {
    const { open } = setup();
    const first = open("s1");
    const second = open("s2");
    expect(first.sent.at(-1)).toMatchObject({ type: "error", code: "superseded" });
    expect(first.closed()).toBe(true);
    expect(second.closed()).toBe(false);
  });

  it("ends the session on anything but a valid frame, stop or cancel", () => {
    for (const data of [
      null,
      "audio",
      { type: "audio", samples: [0, 0] },
      { type: "audio", samples: new Float32Array(0) },
      { type: "audio", samples: new Float32Array(16_001) },
      { type: "nonsense" },
    ]) {
      const { open } = setup();
      const port = open();
      port.send(data);
      expect(port.sent.at(-1)).toMatchObject({ type: "error", code: "invalid-message" });
      expect(port.closed()).toBe(true);
    }
  });

  it("reports a runtime that won't load as unavailable, once, to every request", () => {
    let attempts = 0;
    const { open, service, toMain } = setup(() => {
      attempts++;
      throw new Error("dlopen failed");
    });
    const port = open();
    expect(port.sent).toEqual([{ type: "error", code: "unavailable", message: "dlopen failed" }]);
    expect(port.closed()).toBe(true);
    service.receive({ type: "prewarm", requestId: 4, model: MODEL, threads: 2 }, []);
    expect(toMain.at(-1)).toEqual({
      type: "prewarmed",
      requestId: 4,
      result: { ok: false, code: "unavailable", message: "dlopen failed" },
    });
    expect(attempts).toBe(1);
  });

  it("answers a probe from the runtime alone, loading no model", () => {
    const loads: string[] = [];
    const { service, toMain } = setup(() => fakeRuntime(loads));
    service.receive({ type: "probe", requestId: 9 }, []);
    expect(toMain).toEqual([{ type: "prewarmed", requestId: 9, result: { ok: true } }]);
    expect(loads).toEqual([]);
    const broken = setup(() => {
      throw new Error("Library not loaded: libonnxruntime.dylib");
    });
    broken.service.receive({ type: "probe", requestId: 1 }, []);
    expect(broken.toMain[0]).toMatchObject({ result: { ok: false, code: "unavailable" } });
  });

  it("reports a model the recogniser refuses, and prewarms one it takes", () => {
    let refuse = true;
    const { open, service, toMain } = setup(() => ({
      loadAccurate: noAccurate,
      load: (model, threads) => {
        if (refuse) throw new Error("bad onnx");
        return fakeRuntime().load(model, threads);
      },
    }));
    expect(open().sent).toEqual([
      { type: "error", code: "model-load-failed", message: "bad onnx" },
    ]);
    refuse = false;
    service.receive({ type: "prewarm", requestId: 1, model: MODEL, threads: 2 }, []);
    expect(toMain.at(-1)).toEqual({ type: "prewarmed", requestId: 1, result: { ok: true } });
  });

  it("won't load another model for a prewarm while a session is open", () => {
    const loads: string[] = [];
    const { open, service, toMain } = setup(() => fakeRuntime(loads));
    open();
    const other = { ...MODEL, encoder: "/other/encoder.int8.onnx" };
    service.receive({ type: "prewarm", requestId: 1, model: other, threads: 2 }, []);
    expect(toMain.at(-1)).toMatchObject({
      requestId: 1,
      result: { ok: false, code: "superseded" },
    });
    service.receive({ type: "prewarm", requestId: 2, model: MODEL, threads: 2 }, []);
    expect(toMain.at(-1)).toEqual({ type: "prewarmed", requestId: 2, result: { ok: true } });
    expect(loads.filter((line) => line.startsWith("load"))).toHaveLength(1);
  });

  it("logs counts and timings, never text", () => {
    const { open, logs } = setup();
    const port = open();
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "stop" });
    expect(logs.join("\n")).not.toContain("word");
    expect(logs.at(-1)).toBe('session ended {"frames":1,"decodeMs":0}');
  });
});

/** The accurate pass: speech is any sample of 1, and the text says how many frames of it it heard. */
const fakePass = (
  calls: string[] = [],
  delay: Promise<void> = Promise.resolve(),
): AccuratePass => ({
  segments: (samples) => {
    const segments: { start: number; end: number }[] = [];
    let start = -1;
    samples.forEach((sample, i) => {
      if (sample === 1 && start < 0) start = i;
      if (sample !== 1 && start >= 0) {
        segments.push({ start, end: i });
        start = -1;
      }
    });
    if (start >= 0) segments.push({ start, end: samples.length });
    return segments;
  },
  transcribe: async (samples) => {
    await delay;
    const frames = Math.round(samples.filter((sample) => sample === 1).length / 1_600);
    calls.push(`transcribe ${samples.length}`);
    return `Heard ${frames}.`;
  },
});

const ACCURATE: SpeechAccuratePaths = {
  encoder: "/p/encoder.int8.onnx",
  decoder: "/p/decoder.int8.onnx",
  joiner: "/p/joiner.int8.onnx",
  tokens: "/p/tokens.txt",
  vad: "/v/silero_vad_v5.onnx",
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const openAccurate = (loadAccurate: SpeechRuntime["loadAccurate"]) => {
  const { service, logs, toMain } = setup(() => ({ ...fakeRuntime(), loadAccurate }));
  const port = fakePort();
  service.receive({ type: "open", sessionId: "s1", model: MODEL, threads: 2, accurate: ACCURATE }, [
    port.port,
  ]);
  return { port, logs, toMain, service };
};

describe("speech service, accurate mode", () => {
  it("commits the offline model's text for each utterance, trimmed of its silence", async () => {
    const calls: string[] = [];
    const { port, logs } = openAccurate(async () => fakePass(calls));
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "audio", samples: silence() });
    await settle();
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "stop" });
    await settle();
    expect(port.sent.slice(1)).toEqual([
      { type: "partial", text: "word" },
      { type: "partial", text: "word word" },
      { type: "final", text: "Heard 2.", reason: "endpoint" },
      { type: "partial", text: "word" },
      { type: "final", text: "Heard 1.", reason: "stop" },
    ]);
    // 300 ms of lead, two frames of speech, one of silence: the first 50 ms of the lead go, since
    // only 250 ms are kept before the speech, and the clip ends before the 250 ms after it would.
    expect(calls[0]).toBe("transcribe 8800");
    expect(port.closed()).toBe(true);
    expect(logs.join("\n")).not.toMatch(/Heard|word/);
  });

  it("holds the next utterance's partials until this one's text has committed", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { port } = openAccurate(async () => fakePass([], slow));
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "audio", samples: silence() });
    port.send({ type: "audio", samples: speech() });
    await settle();
    expect(port.sent.at(-1)).toEqual({ type: "partial", text: "word" });
    release();
    await settle();
    expect(port.sent.slice(2)).toEqual([
      { type: "final", text: "Heard 1.", reason: "endpoint" },
      { type: "partial", text: "word" },
    ]);
  });

  it("commits nothing for an utterance the detector heard nobody in", async () => {
    const calls: string[] = [];
    const { port } = openAccurate(async () => ({
      ...fakePass(calls),
      segments: () => [],
    }));
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "audio", samples: silence() });
    port.send({ type: "stop" });
    await settle();
    expect(port.sent.filter((message) => message.type === "final")).toEqual([
      { type: "final", text: "", reason: "stop" },
    ]);
    expect(calls).toEqual([]);
  });

  it("falls back to the stream's text when the pass won't load, and tries again next time", async () => {
    let attempts = 0;
    const { port, service } = openAccurate(() => {
      attempts++;
      return Promise.reject(new Error("bad onnx"));
    });
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "stop" });
    await settle();
    expect(port.sent.at(-1)).toEqual({ type: "final", text: "word", reason: "stop" });
    const again = fakePort();
    service.receive(
      { type: "open", sessionId: "s2", model: MODEL, threads: 2, accurate: ACCURATE },
      [again.port],
    );
    await settle();
    expect(attempts).toBe(2);
  });

  it("loads the pass once and keeps it across sessions until release", async () => {
    let loads = 0;
    const { port, service } = openAccurate(async () => {
      loads++;
      return fakePass();
    });
    port.send({ type: "cancel" });
    const second = fakePort();
    service.receive(
      { type: "open", sessionId: "s2", model: MODEL, threads: 2, accurate: ACCURATE },
      [second.port],
    );
    await settle();
    expect(loads).toBe(1);
    service.receive({ type: "release" }, []);
    const third = fakePort();
    service.receive(
      { type: "open", sessionId: "s3", model: MODEL, threads: 2, accurate: ACCURATE },
      [third.port],
    );
    await settle();
    expect(loads).toBe(2);
  });

  it("drops what an utterance was still committing when the page cancels", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { port } = openAccurate(async () => fakePass([], slow));
    port.send({ type: "audio", samples: speech() });
    port.send({ type: "stop" });
    port.send({ type: "cancel" });
    release();
    await settle();
    expect(port.sent.filter((message) => message.type === "final")).toEqual([]);
    expect(port.closed()).toBe(true);
  });
});

describe("the clip an utterance passes on", () => {
  const second = 16_000;
  it("keeps 250 ms around the speech and nothing when nobody spoke", () => {
    expect(planClip([], 3 * second, false)).toEqual({ speech: undefined });
    expect(planClip([{ start: second, end: 2 * second }], 3 * second, false)).toEqual({
      speech: { start: 12_000, end: 36_000 },
    });
    expect(planClip([{ start: 1_000, end: 3 * second }], 3 * second, false)).toEqual({
      speech: { start: 0, end: 3 * second },
    });
  });

  it("stops a clip cut off mid-speech at its last pause, carrying the rest forward", () => {
    const segments = [
      { start: 0, end: 20 * second },
      { start: 21 * second, end: 30 * second },
    ];
    expect(planClip(segments, 30 * second, true)).toEqual({
      speech: { start: 0, end: 20 * second + 4_000 },
      carryFrom: 21 * second - 4_000,
    });
    // On stop nothing comes after, so all of it goes now.
    expect(planClip(segments, 30 * second, false).carryFrom).toBeUndefined();
    // Nor when the speaker had stopped before the cut, or there's no pause to stop at.
    expect(planClip([{ start: 0, end: 25 * second }], 30 * second, true).carryFrom).toBeUndefined();
    expect(planClip([segments[1]!], 30 * second, true).carryFrom).toBeUndefined();
  });

  it("gathers frames into one clip and starts empty again", () => {
    const utterance = createUtterance();
    utterance.push(new Float32Array([1, 2]));
    utterance.push(new Float32Array([3]));
    expect(utterance.length()).toBe(3);
    expect([...utterance.take()]).toEqual([1, 2, 3]);
    expect(utterance.length()).toBe(0);
  });
});

describe("the loaded ONNX Runtime check", () => {
  it("flags an ONNX Runtime loaded from anywhere but sherpa's platform package", () => {
    const dir = "C:\\app\\resources\\app.asar.unpacked\\node_modules\\sherpa-onnx-win-x64";
    expect(
      foreignOnnxRuntimes(
        [
          `${dir}\\sherpa-onnx.node`,
          `${dir.toUpperCase()}\\onnxruntime.dll`,
          "C:\\Windows\\System32\\onnxruntime.dll",
          "C:\\Windows\\System32\\kernel32.dll",
        ],
        dir,
        "win32",
      ),
    ).toEqual(["C:\\Windows\\System32\\onnxruntime.dll"]);
    const mac = "/Applications/Gram.app/x/node_modules/sherpa-onnx-darwin-arm64";
    expect(
      foreignOnnxRuntimes(
        [`${mac}/libonnxruntime.dylib`, "/opt/homebrew/lib/libonnxruntime.1.22.0.dylib"],
        mac,
        "darwin",
      ),
    ).toEqual(["/opt/homebrew/lib/libonnxruntime.1.22.0.dylib"]);
    const resources = "/Applications/Gram.app/Contents/Resources";
    expect(
      foreignOnnxRuntimes(
        [
          `${resources}/app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.dylib`,
        ],
        `${resources}/app.asar/node_modules/sherpa-onnx-darwin-arm64`,
        "darwin",
      ),
    ).toEqual([]);
    expect(
      foreignOnnxRuntimes(
        [
          "C:\\Gram\\resources\\app.asar.unpacked\\node_modules\\sherpa-onnx-win-x64\\onnxruntime.dll",
        ],
        "C:\\Gram\\resources\\app.asar\\node_modules\\sherpa-onnx-win-x64",
        "win32",
      ),
    ).toEqual([]);
    // As Windows reports a loaded module: by its extended-length name.
    expect(
      foreignOnnxRuntimes(
        [
          "\\\\?\\D:\\a\\resources\\app.asar.unpacked\\node_modules\\sherpa-onnx-win-x64\\onnxruntime.dll",
          "\\\\?\\C:\\Windows\\System32\\onnxruntime.dll",
        ],
        "D:\\a\\resources\\app.asar\\node_modules\\sherpa-onnx-win-x64",
        "win32",
      ),
    ).toEqual(["\\\\?\\C:\\Windows\\System32\\onnxruntime.dll"]);
  });
});
