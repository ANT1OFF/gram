import type { TerminalEvent } from "@gram/contracts";

/** How long output is collected before it goes to the socket. */
export const BATCH_WINDOW_MS = 16;

/** Joins adjacent `data` events of a batch; `replay` and `exit` stay separate and in order. */
export const coalesce = (events: ReadonlyArray<TerminalEvent>): Array<TerminalEvent> => {
  const out: Array<TerminalEvent> = [];
  for (const event of events) {
    const last = out.at(-1);
    if (event.type === "data" && last?.type === "data") {
      out[out.length - 1] = { type: "data", data: last.data + event.data };
    } else {
      out.push(event);
    }
  }
  return out;
};
