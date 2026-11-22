import type { ServerEvent } from "@gram/contracts";

export const watched = (event: ServerEvent): boolean =>
  event.type === "thread.upsert" ||
  event.type === "thread.removed" ||
  event.type === "thread.request" ||
  event.type === "thread.requestResolved" ||
  event.type === "thread.background" ||
  (event.type === "thread.status" && event.status === "error");
