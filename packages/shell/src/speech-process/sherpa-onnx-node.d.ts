// sherpa-onnx-node ships JSDoc, not declarations; this is the slice of its API the speech process
// uses, as of 2.0.0.
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
  export interface OfflineStream {
    acceptWaveform(wave: { readonly sampleRate: number; readonly samples: Float32Array }): void;
  }
  export class OfflineRecognizer {
    static createAsync(config: unknown): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ readonly text: string }>;
  }
  export class Vad {
    constructor(config: unknown, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    /** Electron refuses external buffers, so the page's copy is asked for with `false`. */
    front(enableExternalBuffer: boolean): {
      readonly start: number;
      readonly samples: Float32Array;
    };
    pop(): void;
    flush(): void;
    reset(): void;
  }
}
