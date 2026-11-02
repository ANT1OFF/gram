import { SPEECH_SAMPLE_RATE } from "@gram/contracts";

import type { Capture } from "./session";

/** How long a flush waits for the audio thread, which a lost device can stop answering. */
export const FLUSH_TIMEOUT_MS = 100;

/**
 * Opens the microphone and calls `onFrame` with each 100 ms of mono audio at 16 kHz. Echo
 * cancellation and noise suppression stay on: dictation happens beside speakers and keyboards.
 * Rejects with the `getUserMedia` error.
 */
export async function startCapture(onFrame: (samples: Float32Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let context: AudioContext | undefined;
  try {
    // Chromium resamples the device to the context's rate, so no resampler is needed here.
    context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE, latencyHint: "interactive" });
    // Built by Vite as a module of its own: the audio thread loads it by URL, never this bundle.
    const { default: workletUrl } = await import("./capture-worklet?worker&url");
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "gram-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    let flushed: (() => void) | undefined;
    const onMessage = (event: MessageEvent<Float32Array | "flushed">) => {
      if (event.data === "flushed") flushed?.();
      else onFrame(event.data);
    };
    node.port.addEventListener("message", onMessage);
    node.port.start();
    source.connect(node);
    const opened = context;
    return {
      flush: () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
          flushed = () => {
            clearTimeout(timer);
            resolve();
          };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin
          node.port.postMessage("flush");
        }),
      stop: () => {
        node.port.removeEventListener("message", onMessage);
        node.port.close();
        source.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void opened.close();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context?.close();
    throw error;
  }
}
