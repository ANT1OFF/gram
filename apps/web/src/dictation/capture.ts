import { SPEECH_SAMPLE_RATE } from "@gram/contracts";

import type { Capture } from "./session";

/** How long a flush waits for the audio thread, which a lost device can stop answering. */
export const FLUSH_TIMEOUT_MS = 100;

/** How long "Keep microphone ready" holds the microphone after the last sign of dictating. */
export const KEEP_READY_MS = 2 * 60_000;

/**
 * The whole frames a ready microphone keeps. With the part-frame the worklet holds, a press gets
 * the 400–500 ms before it, about Hex's 450 ms.
 */
export const PRE_ROLL_FRAMES = 4;

export interface Microphone {
  /** Builds the audio graph ahead of a start, which leaves the microphone itself alone. */
  warm(): void;
  /** Turns "Keep microphone ready" on or off; off lets go of a held microphone at once. */
  keepReady(on: boolean): void;
  /** With `keepReady` on, opens the microphone, or holds it for longer, for `KEEP_READY_MS`. */
  ready(): void;
  /**
   * Calls `onFrame` with each 100 ms of mono audio at 16 kHz, a ready microphone's pre-roll first.
   * Rejects with the `getUserMedia` error.
   */
  start(onFrame: (samples: Float32Array) => void): Promise<Capture>;
}

interface Graph {
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  /** Has the worklet post what it gathered; resolves once the page has it. */
  flush(): Promise<void>;
}

interface Open {
  readonly stream: MediaStream;
  readonly source: MediaStreamAudioSourceNode;
  readonly graph: Graph;
}

const tell = (node: AudioWorkletNode, message: "start" | "stop" | "flush") =>
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin
  node.port.postMessage(message);

/**
 * The window's microphone. Echo cancellation and noise suppression stay on: dictation happens
 * beside speakers and keyboards.
 *
 * The audio graph stays built between dictations, suspended so no audio device stays open. The
 * microphone is opened on a press and let go with its stop, unless "Keep microphone ready" holds
 * it open, for `KEEP_READY_MS` after the last sign of dictating. While held, the newest frames sit
 * in memory, replaced as they age, and go nowhere unless a press takes them as its pre-roll.
 */
export function createMicrophone(): Microphone {
  let built: Promise<Graph> | undefined;
  let opened: Promise<Open> | undefined;
  /** Where frames go now; with none, they are a held microphone's pre-roll. */
  let sink: ((samples: Float32Array) => void) | undefined;
  let preRoll: Float32Array[] = [];
  let keeping = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const onFrame = (samples: Float32Array) => {
    if (sink !== undefined) return sink(samples);
    if (opened === undefined) return;
    preRoll.push(samples);
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
  };

  const build = async (): Promise<Graph> => {
    // Chromium resamples the device to the context's rate, so no resampler is needed here.
    const context = new AudioContext({
      sampleRate: SPEECH_SAMPLE_RATE,
      latencyHint: "interactive",
    });
    try {
      // Built by Vite as a module of its own: the audio thread loads it by URL, never this bundle.
      const { default: workletUrl } = await import("./capture-worklet?worker&url");
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, "gram-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      let flushed: (() => void) | undefined;
      node.port.addEventListener("message", (event: MessageEvent<Float32Array | "flushed">) => {
        if (event.data === "flushed") flushed?.();
        else onFrame(event.data);
      });
      node.port.start();
      // Running, a context holds the output device open; a press resumes it.
      if (opened === undefined) await context.suspend();
      return {
        context,
        node,
        flush: () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
            flushed = () => {
              clearTimeout(timer);
              resolve();
            };
            tell(node, "flush");
          }),
      };
    } catch (error) {
      void context.close();
      throw error;
    }
  };

  const graph = (): Promise<Graph> => {
    built ??= build().catch((error: unknown) => {
      built = undefined;
      throw error;
    });
    return built;
  };

  const open = async (): Promise<Open> => {
    // Together: the sooner the microphone runs, the less of the first word is lost, and a graph
    // warmed at the composer's focus is already here.
    const [stream, audio] = await Promise.allSettled([
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
      graph(),
    ]);
    if (stream.status === "rejected") throw stream.reason;
    if (audio.status === "rejected") {
      for (const track of stream.value.getTracks()) track.stop();
      throw audio.reason;
    }
    const { context, node } = audio.value;
    const source = context.createMediaStreamSource(stream.value);
    source.connect(node);
    tell(node, "start");
    void context.resume();
    return { stream: stream.value, source, graph: audio.value };
  };

  const close = ({ stream, source, graph: { context, node } }: Open) => {
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    // Unless a press has opened it again already.
    if (opened !== undefined) return;
    tell(node, "stop");
    void context.suspend();
  };

  const letGo = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    preRoll = [];
    const closing = opened;
    opened = undefined;
    void closing?.then(close, () => undefined);
  };

  const acquire = (): Promise<Open> => {
    const opening = (opened ??= open());
    void opening.catch(() => {
      if (opened === opening) opened = undefined;
    });
    return opening;
  };

  const hold = () => {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (sink === undefined) letGo();
    }, KEEP_READY_MS);
  };

  const live = async (): Promise<boolean> => {
    const stream = (await opened?.catch(() => undefined))?.stream;
    return stream?.getAudioTracks().some((track) => track.readyState === "live") === true;
  };

  return {
    warm: () => void graph().catch((error: unknown) => console.warn("dictation", error)),
    keepReady: (on) => {
      keeping = on;
      if (!on && sink === undefined) letGo();
    },
    ready: () => {
      if (!keeping || sink !== undefined) return;
      hold();
      // A held microphone is a nicety: the press that needs it reports what's wrong.
      acquire().catch((error: unknown) => console.warn("dictation", error));
    },
    start: async (deliver) => {
      clearTimeout(holdTimer);
      // A device unplugged while held ended its stream: open whatever is there now.
      if (opened !== undefined && sink === undefined && !(await live())) letGo();
      const held = preRoll;
      preRoll = [];
      for (const frame of held) deliver(frame);
      // From here, even before the microphone answers, so no frame goes to the pre-roll.
      sink = deliver;
      let audio: Open;
      try {
        audio = await acquire();
      } catch (error) {
        if (sink === deliver) sink = undefined;
        throw error;
      }
      return {
        // Another composer's press took the microphone over; this one's stop is no longer its.
        flush: () => (sink === deliver ? audio.graph.flush() : Promise.resolve()),
        stop: () => {
          if (sink !== deliver) return;
          sink = undefined;
          preRoll = [];
          if (keeping) hold();
          else letGo();
        },
      };
    },
  };
}

/** The one microphone a window dictates from, whichever composer has it. */
export const microphone = createMicrophone();
