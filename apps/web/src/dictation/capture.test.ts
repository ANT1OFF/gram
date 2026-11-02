import { SPEECH_SAMPLE_RATE, type SpeechClientMessage } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMicrophone, FLUSH_TIMEOUT_MS, KEEP_READY_MS, PRE_ROLL_FRAMES } from "./capture";
import { createDictation, LEAD_SILENCE_FRAMES, STOP_TAIL_MS, type DictationPort } from "./session";

vi.mock("./capture-worklet?worker&url", () => ({ default: "capture-worklet.js" }));

/** One render quantum, as the audio thread gets it. */
const QUANTUM = 128;
const QUANTUM_MS = (QUANTUM / SPEECH_SAMPLE_RATE) * 1000;
/** How long a message takes between the threads. */
const HOP_MS = 1;

const samplesOf = (ms: number) => Math.round((ms / 1000) * SPEECH_SAMPLE_RATE);

/** A 16-bit mono WAV of `seconds`, each span between its `words` a tone and the rest silence. */
const wavOf = (seconds: number, words: readonly (readonly [number, number])[]): Uint8Array => {
  const length = samplesOf(seconds * 1000);
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SPEECH_SAMPLE_RATE, true);
  view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  for (const [from, to] of words)
    for (let i = samplesOf(from * 1000); i < samplesOf(to * 1000); i++)
      view.setInt16(
        44 + i * 2,
        Math.round(16_000 * Math.sin((2 * Math.PI * 220 * i) / 16_000)),
        true,
      );
  return bytes;
};

const readWav = (bytes: Uint8Array): Float32Array => {
  const view = new DataView(bytes.buffer, 44);
  const samples = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32_768;
  return samples;
};

/** One end of a port between the page and the audio thread, a hop away from the other. */
class ThreadPort {
  peer: ThreadPort | undefined;
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  postMessage(data: unknown) {
    setTimeout(() => {
      for (const listener of this.peer?.listeners ?? []) listener({ data });
    }, HOP_MS);
  }
  addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.delete(listener);
  }
  start() {}
  close() {}
}

interface Processor {
  process(inputs: Float32Array[][]): boolean;
}

/** Web Audio around the real worklet: `render` runs the processor as the audio thread would. */
const fakeWebAudio = async () => {
  let processorClass: (new () => Processor) | undefined;
  const pending: { port?: ThreadPort } = {};
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port = pending.port!;
    },
  );
  vi.stubGlobal("registerProcessor", (_name: string, value: new () => Processor) => {
    processorClass = value;
  });
  vi.resetModules();
  await import("./capture-worklet");

  const graph: { processor?: Processor; port?: ThreadPort; connected: boolean } = {
    connected: false,
  };
  const track = { stop: vi.fn(), readyState: "live" };
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  }));
  const context = { made: 0, running: true };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    "AudioContext",
    class {
      readonly audioWorklet = { addModule: async () => {} };
      constructor() {
        context.made += 1;
      }
      suspend = async () => {
        context.running = false;
      };
      resume = async () => {
        context.running = true;
      };
      createMediaStreamSource = () => ({
        connect: () => {
          graph.connected = true;
        },
        disconnect: () => {
          graph.connected = false;
        },
      });
      close = async () => {};
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port = new ThreadPort();
      constructor() {
        const audio = new ThreadPort();
        audio.peer = this.port;
        this.port.peer = audio;
        pending.port = audio;
        graph.processor = new processorClass!();
        graph.port = this.port;
      }
    },
  );
  return { graph, track, getUserMedia, context };
};

/** The speech process's end of a session, which keeps the audio it's sent. */
const hearingPort = () => {
  const sent: SpeechClientMessage[] = [];
  const port: DictationPort = {
    postMessage: (message) => sent.push(message),
    addEventListener: () => {},
    removeEventListener: () => {},
    start: () => {},
    close: () => {},
  };
  const heard = () => {
    const frames = sent
      .flatMap((m) => (m.type === "audio" ? [m.samples] : []))
      .slice(LEAD_SILENCE_FRAMES);
    const all = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
    let at = 0;
    for (const frame of frames) {
      all.set(frame, at);
      at += frame.length;
    }
    return all;
  };
  return { port, sent, heard };
};

/** Plays `audio` through a real dictation and lets go at `releaseMs`, as far as the mic stays on. */
const replay = async (audio: Float32Array, releaseMs: number, stopTailMs?: number) => {
  const { graph } = await fakeWebAudio();
  const session = hearingPort();
  const dictation = createDictation(
    {
      open: async () => ({ ok: true, port: session.port }),
      startCapture: createMicrophone().start,
      newSessionId: () => "s1",
      ...(stopTailMs === undefined ? {} : { stopTailMs }),
    },
    { onState: () => {}, onPartial: () => {}, onCommit: () => {} },
  );
  await dictation.start({ modelId: "m" });
  await vi.advanceTimersByTimeAsync(HOP_MS);
  let released = false;
  for (let at = 0; at + QUANTUM <= audio.length && graph.connected; at += QUANTUM) {
    if (!released && (at / SPEECH_SAMPLE_RATE) * 1000 >= releaseMs) {
      released = true;
      dictation.stop();
    }
    graph.processor!.process([[audio.slice(at, at + QUANTUM)]]);
    await vi.advanceTimersByTimeAsync(QUANTUM_MS);
  }
  await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS);
  return { ...session, stopped: session.sent.at(-1)?.type === "stop" };
};

/** A 2.5 s clip whose second and last word ends a second before the clip does. */
const END_OF_SPEECH_S = 1.5;
const clip = () =>
  readWav(
    wavOf(END_OF_SPEECH_S + 1, [
      [0.3, 0.7],
      [0.8, END_OF_SPEECH_S],
    ]),
  );

describe("the last word", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([-100, -50, 0, 50, 100, 200])(
    "reaches the speech process whole on a release %i ms from the end of speech",
    async (offsetMs) => {
      const audio = clip();
      const { heard, stopped } = await replay(audio, END_OF_SPEECH_S * 1000 + offsetMs);
      expect(stopped).toBe(true);
      const end = samplesOf(END_OF_SPEECH_S * 1000);
      const kept = heard();
      expect(kept.length).toBeGreaterThanOrEqual(end);
      expect(kept.slice(0, end)).toEqual(audio.slice(0, end));
    },
  );

  it("is cut with no tail, so this harness sees the clipping it guards against", async () => {
    const audio = clip();
    const { heard } = await replay(audio, END_OF_SPEECH_S * 1000 - 100, 0);
    expect(heard().length).toBeLessThan(samplesOf(END_OF_SPEECH_S * 1000 - 50));
  });

  it("runs the microphone for the tail and no longer", async () => {
    const audio = clip();
    const release = 1000;
    const { heard } = await replay(audio, release);
    const spare = samplesOf(STOP_TAIL_MS + 2 * HOP_MS + 2 * QUANTUM_MS);
    expect(heard().length).toBeGreaterThanOrEqual(samplesOf(release + STOP_TAIL_MS) - 2 * QUANTUM);
    expect(heard().length).toBeLessThanOrEqual(samplesOf(release) + spare);
  });

  it("sends the short last frame, and every other frame at full size", async () => {
    const { sent } = await replay(clip(), 1013);
    const frames = sent.flatMap((m) => (m.type === "audio" ? [m.samples.length] : []));
    expect(frames.at(-1)).toBeLessThan(1600);
    expect(frames.at(-1)).toBeGreaterThan(0);
    expect(new Set(frames.slice(0, -1))).toEqual(new Set([1600]));
  });

  it("stops waiting for an audio thread that stopped answering", async () => {
    const { graph, track } = await fakeWebAudio();
    const capture = await createMicrophone().start(() => {});
    graph.port!.peer = undefined;
    let done = false;
    void capture.flush().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    capture.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.stop).toHaveBeenCalled();
  });
});

/** Runs the audio thread for `frames` 100 ms frames, each sample `value`. */
const render = async (processor: Processor, frames: number, value: number) => {
  for (let i = 0; i < Math.ceil((frames * 1600) / QUANTUM); i++) {
    processor.process([[new Float32Array(QUANTUM).fill(value)]]);
    await vi.advanceTimersByTimeAsync(QUANTUM_MS);
  }
  await vi.advanceTimersByTimeAsync(2 * HOP_MS);
};

describe("the microphone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("warms the graph without opening the microphone, and keeps it suspended between dictations", async () => {
    const { getUserMedia, context, track } = await fakeWebAudio();
    const microphone = createMicrophone();
    microphone.warm();
    microphone.warm();
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(context).toEqual({ made: 1, running: false });

    for (let i = 1; i <= 2; i++) {
      const capture = await microphone.start(() => {});
      expect(context.running).toBe(true);
      capture.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(context.running).toBe(false);
      expect(track.stop).toHaveBeenCalledTimes(i);
    }
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(context.made).toBe(1);
  });

  it("never carries a discarded part-frame into the next dictation", async () => {
    const { graph } = await fakeWebAudio();
    const microphone = createMicrophone();
    const discarded = await microphone.start(() => {});
    await vi.advanceTimersByTimeAsync(HOP_MS);
    await render(graph.processor!, 0.5, 0.9);
    discarded.stop();
    await vi.advanceTimersByTimeAsync(0);

    const frames: Float32Array[] = [];
    const next = await microphone.start((samples) => frames.push(samples));
    await vi.advanceTimersByTimeAsync(2 * HOP_MS);
    await render(graph.processor!, 1, 0.1);
    next.stop();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.every((v) => Math.abs(v - 0.1) < 1e-6))).toBe(true);
  });

  it("fails a start on the getUserMedia error, and the next start tries afresh", async () => {
    const { getUserMedia } = await fakeWebAudio();
    const microphone = createMicrophone();
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotFoundError" }));
    await expect(microphone.start(() => {})).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(microphone.start(() => {})).resolves.toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("opens nothing to keep ready unless the setting is on", async () => {
    const { getUserMedia } = await fakeWebAudio();
    const microphone = createMicrophone();
    microphone.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("hands a press the newest frames it held, in order, then the live ones", async () => {
    const { graph, getUserMedia } = await fakeWebAudio();
    const microphone = createMicrophone();
    microphone.keepReady(true);
    microphone.ready();
    await vi.advanceTimersByTimeAsync(2 * HOP_MS);
    for (let frame = 1; frame <= PRE_ROLL_FRAMES + 3; frame++)
      await render(graph.processor!, 1, frame / 100);

    const heard: number[] = [];
    const capture = await microphone.start((samples) => heard.push(samples[0]!));
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(heard).toHaveLength(PRE_ROLL_FRAMES);
    expect(heard.toSorted((a, b) => a - b)).toEqual(heard);
    expect(heard.at(-1)).toBeGreaterThan(0.05);
    const before = heard.length;
    await render(graph.processor!, 2, 0.5);
    expect(heard.length).toBeGreaterThan(before);
    capture.stop();
  });

  it("holds on after a dictation for the bound and no longer, with nothing of it kept", async () => {
    const { graph, track, getUserMedia, context } = await fakeWebAudio();
    const microphone = createMicrophone();
    microphone.keepReady(true);
    const dictated = await microphone.start(() => {});
    await vi.advanceTimersByTimeAsync(2 * HOP_MS);
    await render(graph.processor!, 2, 0.9);
    dictated.stop();
    expect(track.stop).not.toHaveBeenCalled();

    const again: Float32Array[] = [];
    (await microphone.start((samples) => again.push(samples))).stop();
    expect(again).toEqual([]);
    expect(getUserMedia).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(KEEP_READY_MS - 1);
    expect(track.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.running).toBe(false);
  });

  it("a focus extends the hold, and turning the setting off lets go at once", async () => {
    const { track, getUserMedia } = await fakeWebAudio();
    const microphone = createMicrophone();
    microphone.keepReady(true);
    microphone.ready();
    await vi.advanceTimersByTimeAsync(KEEP_READY_MS - 1);
    microphone.ready();
    await vi.advanceTimersByTimeAsync(KEEP_READY_MS - 1);
    expect(track.stop).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledOnce();
    microphone.keepReady(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("doesn't time out under a dictation, and reopens a stream that ended while held", async () => {
    const { track, getUserMedia } = await fakeWebAudio();
    const microphone = createMicrophone();
    microphone.keepReady(true);
    microphone.ready();
    await vi.advanceTimersByTimeAsync(0);
    const capture = await microphone.start(() => {});
    await vi.advanceTimersByTimeAsync(KEEP_READY_MS * 2);
    expect(track.stop).not.toHaveBeenCalled();
    capture.stop();

    track.readyState = "ended";
    (await microphone.start(() => {})).stop();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("leaves the microphone with the composer that took it over", async () => {
    const { track } = await fakeWebAudio();
    const microphone = createMicrophone();
    const first = await microphone.start(() => {});
    const second = await microphone.start(() => {});
    await first.flush();
    first.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.stop).not.toHaveBeenCalled();
    second.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
