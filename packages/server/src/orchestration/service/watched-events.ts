import type { ServerEvent } from "@gram/contracts";

// Hub events worth a place in the queue; status flips and streaming would flood it.
export const watched = (event: ServerEvent): boolean =>
  event.type === "thread.upsert" ||
  event.type === "thread.removed" ||
  event.type === "thread.request" ||
  event.type === "thread.requestResolved" ||
  event.type === "thread.background" ||
  (event.type === "thread.status" && event.status === "error");
