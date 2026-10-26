import type { SpeechServerMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import type { SpeechModelPaths, SpeechProcessMessage } from "./protocol.ts";
import {
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
const fakeRuntime = (log: string[] = []): SpeechRuntime => ({
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
