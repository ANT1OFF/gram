import { SPEECH_SAMPLE_RATE } from "@gram/contracts";

import type { Capture } from "./session";

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
    const onMessage = (event: MessageEvent<Float32Array>) => onFrame(event.data);
    node.port.addEventListener("message", onMessage);
    node.port.start();
    source.connect(node);
    const opened = context;
    return {
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
