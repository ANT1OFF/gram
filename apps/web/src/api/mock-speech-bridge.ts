import {
  SPEECH_PORT_MESSAGE,
  type DesktopSpeech,
  type MicrophoneAccess,
  type SpeechErrorCode,
  type SpeechOpenRequest,
  type SpeechOpenResult,
  type SpeechPerformance,
  type SpeechServerMessage,
} from "@gram/contracts";

/**
 * The desktop shell's speech process, for the mock API: it hears `script` one word per few audio
 * frames, so a spec with Chromium's fake microphone sees partials grow and a final commit. Specs
 * reach it through `window.gramMock.speechBridge`.
 */
export class MockSpeechBridge implements DesktopSpeech {
  /** What the next session "hears". */
  script = "Refactor the model store so it resumes downloads.";
  /** Audio frames (100 ms each) per word heard. */
  framesPerWord = 2;
  /** Set by a spec: the next `open` fails this way. */
  failOpen: { readonly code: SpeechErrorCode; readonly message: string } | undefined;
  access: MicrophoneAccess = "granted";
  /** Frames received by the last session, so a spec can tell audio flowed. */
  framesHeard = 0;
  /** Messages a spec can push into the open session, an error say. */
  #send: ((message: SpeechServerMessage) => void) | undefined;

  async open(request: SpeechOpenRequest): Promise<SpeechOpenResult> {
    this.loads.push([request.modelId, request.performance]);
    const failure = this.failOpen;
    if (failure !== undefined) {
      this.failOpen = undefined;
      return { ok: false, ...failure };
    }
    const channel = new MessageChannel();
    const ours = channel.port1;
    const words = this.script.split(/\s+/).filter((word) => word !== "");
    const framesPerWord = this.framesPerWord;
    let frames = 0;
    let heard = 0;
    this.framesHeard = 0;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin
    const send = (message: SpeechServerMessage) => ours.postMessage(message);
    this.#send = send;
    ours.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
      const message = event.data;
      if (message.type === "audio") {
        this.framesHeard = ++frames;
        const next = Math.min(words.length, Math.floor(frames / framesPerWord));
        if (next > heard) {
          heard = next;
          send({ type: "partial", text: words.slice(0, heard).join(" ") });
        }
        return;
      }
      this.#send = undefined;
      // The page closes its end once the last `final` is in; closing here could drop it.
      if (message.type === "stop")
        send({ type: "final", text: words.slice(0, heard).join(" "), reason: "stop" });
      else ours.close();
    });
    ours.start();
    send({ type: "ready", loadMs: 0 });
    // As the preload does: the port arrives as a window message carrying the session id.
    window.postMessage(
      { type: SPEECH_PORT_MESSAGE, sessionId: request.sessionId },
      location.origin,
      [channel.port2],
    );
    return { ok: true };
  }

  /** Delivers `message` on the open session, as the speech process would. */
  emit(message: SpeechServerMessage): void {
    this.#send?.(message);
  }

  /** Each prewarm, and each session opened, as `[modelId, performance]`. */
  readonly loads: [string, string | undefined][] = [];
  /** How often the speech process was stopped from Settings. */
  shutdowns = 0;

  async prewarm(modelId: string, performance?: SpeechPerformance): Promise<SpeechOpenResult> {
    this.loads.push([modelId, performance]);
    return { ok: true };
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
    this.emit({ type: "error", code: "stopped", message: "Voice input was turned off." });
    this.#send = undefined;
  }

  async microphoneAccess(): Promise<MicrophoneAccess> {
    return this.access;
  }

  async requestMicrophoneAccess(): Promise<MicrophoneAccess> {
    return this.access;
  }

  async openMicrophoneSettings(): Promise<boolean> {
    return false;
  }
}
