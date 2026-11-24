import type { SpeechHostMessage } from "./protocol.ts";
import { createSpeechService } from "./service.ts";
import { loadSherpaRuntime } from "./sherpa.ts";

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron parentPort
const send = (message: unknown) => process.parentPort.postMessage(message);

const service = createSpeechService({
  loadRuntime: () => loadSherpaRuntime(import.meta.url),
  send,
  log: (event, fields) => {
    process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
  },
  now: () => performance.now(),
  exit: () => setTimeout(() => process.exit(0), 100),
});

process.parentPort.on("message", (event) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- main is Gram's own process, and posts only protocol.ts's messages
  const message = event.data as SpeechHostMessage;
  service.receive(message, event.ports);
});
