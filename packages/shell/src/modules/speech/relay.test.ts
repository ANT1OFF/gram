import { describe, expect, it } from "vitest";

import { createSpeechRelay, type RelayWindow } from "./relay.ts";

const nextMessage = (port: MessagePort) =>
  new Promise<unknown>((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data), { once: true });
    port.start();
  });

const setup = () => {
  const posted: { message: unknown; origin: string; port: MessagePort }[] = [];
  const window: RelayWindow = {
    location: { origin: "http://127.0.0.1:4317" },
    postMessage: (message, origin, transfer) =>
      posted.push({ message, origin, port: transfer[0]! }),
  };
  const relay = createSpeechRelay(window);
  // `speech` stands in for the speech process's end of the channel main brokered.
  const { port1: speech, port2: upstream } = new MessageChannel();
  relay.attach("s1", upstream);
  const page = posted[0]!.port;
  return { relay, posted, page, speech };
};

describe("speech relay", () => {
  it("posts the page its own port, to its own origin, and relays both ways", async () => {
    const { posted, page, speech } = setup();
    expect(posted[0]!.message).toEqual({ type: "gram:speech-port", sessionId: "s1" });
    expect(posted[0]!.origin).toBe("http://127.0.0.1:4317");

    const frame = new Float32Array([0.5, -0.5]);
    const heard = nextMessage(speech);
    page.postMessage({ type: "audio", samples: frame }, [frame.buffer]);
    expect(await heard).toEqual({ type: "audio", samples: new Float32Array([0.5, -0.5]) });

    const partial = nextMessage(page);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort
    speech.postMessage({ type: "partial", text: "hello" });
    expect(await partial).toEqual({ type: "partial", text: "hello" });
    page.close();
    speech.close();
  });

  it("tells the page on its own port when the speech process crashed", async () => {
    const { relay, page, speech } = setup();
    const error = nextMessage(page);
    relay.crashed("s1", "the speech process exited with code 139");
    expect(await error).toEqual({
      type: "error",
      code: "crashed",
      message: "the speech process exited with code 139",
    });
    relay.crashed("s1", "again");
    speech.close();
  });

  it("reports the speech process's end going without a word as a crash", async () => {
    const { page, speech } = setup();
    const error = nextMessage(page);
    speech.close();
    expect(await error).toMatchObject({ type: "error", code: "crashed" });
  });

  it("closes quietly after the last message", async () => {
    const { page, speech } = setup();
    const messages: unknown[] = [];
    page.addEventListener("message", (event) => messages.push(event.data));
    page.start();
    const closed = new Promise((resolve) => page.addEventListener("close", resolve));
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort
    speech.postMessage({ type: "final", text: "done", reason: "stop" });
    speech.close();
    await closed;
    expect(messages).toEqual([{ type: "final", text: "done", reason: "stop" }]);
  });
});
