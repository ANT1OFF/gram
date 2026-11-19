// A joined machine that went away under a thread's session and didn't come back in time
// (`EndedEvent.lostMachine`). The turn fails, saying so (`ThreadError.machineLost`), and the
// thread's work in progress is what was last kept of it (`wip-keeper.ts`). Resuming sends the same
// conversation a note of what happened, which opens it again on the machine once it is back, on
// its folder as kept.

import { MACHINE_LOST_DURING_MAX, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { EventHub } from "../events/event-hub.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

/** The `noticeKeys` key of the note a resume after a lost machine starts with. */
export const MACHINE_LOST_KEY = "machine-lost";

/** The note the resumed turn starts with, in Gram's words. */
export const machineLostText = (machine: string, during?: string): string =>
  `Note: ${machine}, the machine this session runs on, was lost and your last turn was cut off` +
  (during === undefined ? "" : ` while \`${during}\` ran`) +
  ". This is the same conversation, resumed after it came back. The folder is as it was last " +
  "saved, a few minutes before the machine went, so check what is there before you carry on: " +
  "the last edits may be missing, and anything that was running (shells, background tasks, " +
  "subagents) stopped. Run again what was cut off, then continue where you left off.";

/** What a tool call the loss cut off ends with: it was stopped, how it ended is unknown. */
export const machineLostToolText = (machine: string): string =>
  `Interrupted: ${machine} was lost while this ran, so it stopped before it finished. Its result is unknown.`;

/** The command of the first cut-off tool call that ran one, as the machine-lost card shows it. */
export const commandDuring = (inputs: ReadonlyArray<unknown>): string | undefined => {
  for (const input of inputs) {
    if (typeof input !== "object" || input === null) continue;
    const command = (input as Record<string, unknown>)["command"];
    if (typeof command !== "string") continue;
    const line = command.replace(/\s+/g, " ").trim();
    if (line === "") continue;
    return line.length <= MACHINE_LOST_DURING_MAX
      ? line
      : `${line.slice(0, MACHINE_LOST_DURING_MAX - 1).trimEnd()}…`;
  }
  return undefined;
};

/**
 * Resumes a thread whose machine was lost under it (`Thread.machineIncident`, or a `lastError` from
 * before it that says so): the same conversation is sent the note above, and the incident is
 * cleared, as a resume clears it; a failure of the resumed turn on a machine still away sets it
 * again. False, and nothing sent, when no lost machine cut it off.
 */
export const resumeAfterMachineLost = (
  store: Pick<ThreadStore["Service"], "getThread" | "updateThread">,
  runtimes: Pick<ThreadRuntimesShape, "sendNotice">,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const thread = yield* store.getThread(threadId);
    const lost = thread.machineIncident ?? thread.lastError?.machineLost;
    if (lost === undefined) return false;
    yield* runtimes.sendNotice(threadId, MACHINE_LOST_KEY, {
      text: machineLostText(lost.machine, lost.during),
      author: "server",
    });
    if (thread.machineIncident !== undefined) {
      const next = yield* store
        .updateThread(threadId, (current) => {
          const { machineIncident: _, ...rest } = current;
          return rest;
        })
        .pipe(Effect.orDie);
      const hub = yield* Effect.serviceOption(EventHub);
      if (Option.isSome(hub)) yield* hub.value.publish({ type: "thread.upsert", thread: next });
    }
    return true;
  });
