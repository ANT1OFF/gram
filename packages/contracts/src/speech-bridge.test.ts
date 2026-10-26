import { describe, expect, it } from "vitest";
import {
  isSpeechModelId,
  isSpeechPerformance,
  microphoneErrorMessage,
  SPEECH_PERFORMANCE_STOPS,
  openSpeechSession,
  SPEECH_PORT_MESSAGE,
  type DesktopSpeech,
  type SpeechOpenResult,
  type SpeechPortTarget,
} from "./speech-bridge.ts";

const fakeTarget = () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const target: SpeechPortTarget = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const post = (data: unknown, ports: readonly MessagePort[]) => {
    for (const listener of listeners) listener({ data, ports } as unknown as MessageEvent);
  };
  return { target, post, listeners };
};

const speechOpening = (open: DesktopSpeech["open"]): DesktopSpeech => ({
  open,
  prewarm: () => Promise.resolve({ ok: true }),
  microphoneAccess: () => Promise.resolve("granted"),
  requestMicrophoneAccess: () => Promise.resolve("granted"),
  openMicrophoneSettings: () => Promise.resolve(false),
});

describe("speech bridge", () => {
  it("takes only single path segments as model ids", () => {
    expect(isSpeechModelId("nemotron-speech-streaming-en-0.6b-560ms-int8")).toBe(true);
    expect(isSpeechModelId("../models")).toBe(false);
    expect(isSpeechModelId(".hidden")).toBe(false);
    expect(isSpeechModelId("a/b")).toBe(false);
    expect(isSpeechModelId("A")).toBe(false);
    expect(isSpeechModelId("")).toBe(false);
    expect(isSpeechModelId("x".repeat(129))).toBe(false);
    expect(isSpeechModelId(7)).toBe(false);
  });

  it("resolves with the port posted for its own session, even before open answers", async () => {
    const { target, post, listeners } = fakeTarget();
    const { port1, port2 } = new MessageChannel();
    const answer = Promise.withResolvers<SpeechOpenResult>();
    const speech = speechOpening(() => answer.promise);
    const session = openSpeechSession(speech, { sessionId: "s1", modelId: "m" }, target);
    post({ type: SPEECH_PORT_MESSAGE, sessionId: "other" }, [port2]);
    post({ type: "unrelated" }, [port2]);
    post({ type: SPEECH_PORT_MESSAGE, sessionId: "s1" }, [port1]);
    answer.resolve({ ok: true });
    expect(await session).toEqual({ ok: true, port: port1 });
    expect(listeners.size).toBe(0);
    port1.close();
    port2.close();
  });

  it("resolves with the failure when open refuses or throws, and stops listening", async () => {
    const { target, listeners } = fakeTarget();
    const refused = await openSpeechSession(
      speechOpening(() =>
        Promise.resolve({ ok: false, code: "model-missing", message: "no model" }),
      ),
      { sessionId: "s1", modelId: "m" },
      target,
    );
    expect(refused).toEqual({ ok: false, code: "model-missing", message: "no model" });
    const thrown = await openSpeechSession(
      speechOpening(() => Promise.reject(new Error("untrusted sender"))),
      { sessionId: "s2", modelId: "m" },
      target,
    );
    expect(thrown).toMatchObject({ ok: false, code: "unavailable" });
    const threwSync = await openSpeechSession(
      speechOpening(() => {
        throw new Error("untrusted sender");
      }),
      { sessionId: "s3", modelId: "m" },
      target,
    );
    expect(threwSync).toMatchObject({ ok: false, code: "unavailable" });
    expect(listeners.size).toBe(0);
  });

  it("names three performance stops, each with a model chunk and a thread count", () => {
    expect(Object.keys(SPEECH_PERFORMANCE_STOPS)).toEqual(["responsive", "balanced", "efficient"]);
    expect(SPEECH_PERFORMANCE_STOPS.balanced).toEqual({ chunkMs: 560, threads: 2 });
    expect(isSpeechPerformance("efficient")).toBe(true);
    expect(isSpeechPerformance("fast")).toBe(false);
  });

  it("explains a refused microphone by platform, pointing at the privacy setting", () => {
    expect(microphoneErrorMessage({ name: "NotAllowedError" }, "win32")).toContain(
      "Let desktop apps access your microphone",
    );
    expect(microphoneErrorMessage({ name: "NotAllowedError" }, "darwin")).toContain(
      "Privacy & Security → Microphone",
    );
    expect(microphoneErrorMessage({ name: "NotReadableError" }, "win32")).toContain("privacy");
    expect(microphoneErrorMessage({ name: "NotFoundError" }, "darwin")).toContain("No microphone");
    expect(microphoneErrorMessage({ name: "TypeError" }, "darwin")).toContain("TypeError");
  });
});
