import type { ThreadId } from "@gram/contracts";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";

import { Dialog, DialogShell } from "./dialog-shell";
import { restartInterrupts, restartSession } from "./restart-session";

/**
 * Asks before a restart that would stop work in flight. Mid-turn the user picks between cutting
 * the turn off now and restarting once it ends; with only background tasks running, whether to stop
 * them.
 */
export function RestartSessionDialog({
  threadId,
  onClose,
}: {
  threadId: ThreadId;
  onClose: () => void;
}) {
  const api = useApi();
  // Read once: the choice offered is about the moment the user asked.
  const interrupts = restartInterrupts(threadId);
  const run = (midTurn: "interrupt" | "afterTurn") => {
    restartSession(api, threadId, midTurn);
    onClose();
  };
  return (
    <DialogShell
      testId="restart-session-dialog"
      title="Restart the session?"
      description={
        interrupts === "background"
          ? "The agent has work running in the background, which a restart stops. The conversation carries on in a new session that reads its settings, MCP servers, connectors and instructions again."
          : "A turn is running. Restarting now interrupts it; the conversation carries on in a new session that reads its settings, MCP servers, connectors and instructions again."
      }
      onClose={onClose}
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        {interrupts !== "background" && (
          <Button type="button" variant="outline" size="sm" onClick={() => run("afterTurn")}>
            Restart when this turn ends
          </Button>
        )}
        <Button type="button" size="sm" variant="destructive" onClick={() => run("interrupt")}>
          {interrupts === "background" ? "Stop it and restart" : "Interrupt and restart"}
        </Button>
      </div>
    </DialogShell>
  );
}
