// Runs on the audio rendering thread. The AudioContext runs at 16 kHz, so Chromium has already
// resampled the device's 44.1 or 48 kHz to what the model wants; this only downmixes to mono and
// batches the 128-sample render quanta into 100 ms frames. The graph outlives a dictation, so it
// gathers only between the page's "start" and "stop", and "stop" drops what it hadn't posted. A
// "flush" posts the part of a frame gathered so far, then "flushed", so the page knows it has every
// sample up to there.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

const FRAME = 1600;

/** The processor's registered name, which `capture.ts` repeats rather than import this file. */
const CAPTURE_PROCESSOR = "gram-capture";

class CaptureProcessor extends AudioWorkletProcessor {
  #buffer = new Float32Array(FRAME);
  #filled = 0;
  #gathering = false;

  constructor() {
    super();
    this.port.addEventListener("message", (event: MessageEvent<"start" | "stop" | "flush">) => {
      if (event.data !== "flush") {
        this.#gathering = event.data === "start";
        this.#filled = 0;
        return;
      }
      if (this.#filled > 0) {
        const rest = this.#buffer.slice(0, this.#filled);
        this.port.postMessage(rest, [rest.buffer]);
        this.#filled = 0;
      }
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin
      this.port.postMessage("flushed");
    });
    this.port.start();
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!this.#gathering || channels === undefined || channels.length === 0) return true;
    const length = channels[0]!.length;
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i]!;
      this.#buffer[this.#filled++] = sum / channels.length;
      if (this.#filled === FRAME) {
        this.port.postMessage(this.#buffer, [this.#buffer.buffer]);
        this.#buffer = new Float32Array(FRAME);
        this.#filled = 0;
      }
    }
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
