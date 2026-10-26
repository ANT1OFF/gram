import { MockSpeechStore } from "../mock-speech";
import { MockSpeechBridge } from "../mock-speech-bridge";
import type { SpeechApi } from "./types";

/**
 * `SpeechApi` over `MockSpeechStore`, and the desktop shell's speech
 * process a browser lacks.
 */
export function createSpeechMock() {
  /** The speech model store; specs reach it through `window.gramMock`. */
  const speech = new MockSpeechStore();
  /** The desktop shell's speech process, which a browser lacks; dictation finds it here. */
  const speechBridge = new MockSpeechBridge();
  return {
    speech,
    speechBridge,
    speechStatus: (model) => speech.status(model),
    watchSpeechInstall: (model, signal) => speech.watch(model, signal),
    installSpeechModel: (model) => speech.install(model),
    cancelSpeechInstall: (model) => speech.cancel(model),
    removeSpeechModel: (model) => speech.remove(model),
  } satisfies SpeechApi & {
    speech: MockSpeechStore;
    speechBridge: MockSpeechBridge;
  };
}
