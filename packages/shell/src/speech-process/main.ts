// The local recogniser runs in an Electron utility process. Native crashes and model memory
// are isolated from the server and agents. Logs contain event names and numbers only.

import type { SpeechHostMessage } from "./protocol.ts";
import { createSpeechService, type SessionPort } from "./service.ts";
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
  // A moment for the `stopped` just posted to cross the port, which closing it with the process
  // would otherwise drop.
  exit: () => setTimeout(() => process.exit(0), 100),
});

process.parentPort.on("message", (event) => {
  const message = event.data as SpeechHostMessage;
  service.receive(message, event.ports as readonly SessionPort[]);
});
