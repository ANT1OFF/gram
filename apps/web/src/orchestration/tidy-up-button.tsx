import type { WorkspaceState } from "@gram/contracts";
import { BroomSparkles, Check } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";
import { useViewWorkspace } from "@/views/view-workspace";

import { useTidyUp } from "./use-board-actions";

const TIDY_HINT =
  "Tidy up: ask the orchestrator to archive what's done, fix groups, stages and plans, close settled questions and refresh its memory";

/** Asks the orchestrator to tidy its board and memory, after whatever it is doing now. */
function TidyUpButton({
  state,
  testId,
  size = "icon-sm",
  className,
}: {
  state: WorkspaceState;
  testId: string;
  size?: "icon-xs" | "icon-sm";
  className?: string | undefined;
}) {
  const tidy = useTidyUp(state);
  const hint =
    tidy.blocked ??
    (tidy.sent === "queued"
      ? "Asked: the orchestrator tidies up once its current turn ends"
      : tidy.sent === "sent"
        ? "Asked: the orchestrator is tidying up"
        : TIDY_HINT);
  return (
    <>
      <Hint
        label={hint}
        side="bottom"
        render={
          <Button
            size={size}
            variant="ghost"
            data-testid={testId}
            data-sent={tidy.sent}
            aria-label={tidy.blocked === undefined ? "Tidy up" : `Tidy up (${tidy.blocked})`}
            disabled={tidy.blocked !== undefined || tidy.resting}
            focusableWhenDisabled
            className={cn(
              "text-muted-foreground data-sent:text-foreground",
              tidy.blocked !== undefined && "opacity-50",
              className,
            )}
            onClick={() => void tidy.send()}
          />
        }
      >
        <Swap swapKey={tidy.sent === undefined ? "idle" : "sent"}>
          {tidy.sent === undefined ? <BroomSparkles aria-hidden /> : <Check aria-hidden />}
        </Swap>
      </Hint>
      {tidy.sent !== undefined && (
        <span role="status" className="sr-only">
          {hint}
        </span>
      )}
    </>
  );
}

/** The title bar's Tidy up, for the workspace the window is on. Shown only where one is. */
export function TitlebarTidyUp({ className }: { className?: string }) {
  const state = useViewWorkspace();
  if (state === undefined) return null;
  return (
    <TidyUpButton
      // A workspace switch starts the next one's button fresh, not resting on the last one's send.
      key={state.workspace.id}
      state={state}
      testId="titlebar-tidy"
      size="icon-xs"
      className={className}
    />
  );
}
