import type { RestartMidTurn, ThreadId, ThreadStatus } from "@gram/contracts";

import type { Api } from "@/api/types";
import { errorMessage } from "@/api/errors";
import { useThreadsStore } from "@/stores/threads";

import { useThreadDialogs } from "./thread-dialogs-store";

/** A turn is open, so a restart either waits for it or cuts it off: the user picks which. */
const MID_TURN: ReadonlySet<ThreadStatus> = new Set(["running", "needsApproval", "needsInput"]);

/** Whether restarting `threadId` now stops work in flight: a turn, or background tasks. */
export const restartInterrupts = (threadId: ThreadId) => {
  const summary = useThreadsStore.getState().byId[threadId];
  if (summary === undefined) return undefined;
  if (MID_TURN.has(summary.status)) return "turn" as const;
  if ((summary.background?.length ?? 0) > 0) return "background" as const;
  return undefined;
};

/**
 * Asks `thread.restartSession` and says what came of it: a toast when it waits for the turn or has
 * nothing to restart, the action-error dialog when it is refused. The marker in the transcript is
 * the rest of the answer.
 */
export const restartSession = (api: Api, threadId: ThreadId, midTurn?: RestartMidTurn) => {
  const notify = (title: string, body: string) =>
    useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title, body, threadId });
  api
    .restartSession(threadId, midTurn)
    .then((outcome) => {
      if (outcome === "afterTurn") {
        notify("Restarts when this turn ends", "The session then reloads its config.");
      } else if (outcome === "noSession") {
        notify(
          "Nothing to restart yet",
          "The thread's first message starts a session with the config as it is now.",
        );
      }
    })
    .catch((error: unknown) =>
      useThreadDialogs.getState().fail(`Couldn't restart the session: ${errorMessage(error)}`),
    );
};

/**
 * The menus' and the palette's "Restart session": straight away at rest, and through the confirm
 * when it would cut a turn or a background task off.
 */
export const requestRestart = (api: Api, threadId: ThreadId) => {
  const interrupts = restartInterrupts(threadId);
  if (interrupts === undefined) return restartSession(api, threadId);
  useThreadDialogs.getState().open({ kind: "restartSession", threadId });
};
