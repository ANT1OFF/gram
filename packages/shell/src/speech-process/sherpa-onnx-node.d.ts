// sherpa-onnx-node ships JSDoc, not declarations; this is the slice of its API the speech process
// uses, as of 1.13.8.
declare module "sherpa-onnx-node" {
  export interface OnlineStream {
    acceptWaveform(wave: { readonly sampleRate: number; readonly samples: Float32Array }): void;
    inputFinished(): void;
    setOption(key: string, value: string): void;
  }
  export class OnlineRecognizer {
    constructor(config: unknown);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): { readonly text: string };
  }
}
