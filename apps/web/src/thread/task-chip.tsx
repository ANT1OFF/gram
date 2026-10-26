import type { TaskChipData, ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitBranch, ListPlus } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";

import { taskStart, taskStartLabel } from "./task-chip-model";

/** A follow-up offered by `spawn_task`; accepting opens it as a new thread. */
export function TaskChip({ threadId, chip }: { threadId: ThreadId; chip: TaskChipData }) {
  const api = useApi();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);

  const accept = async () => {
    setPending(true);
    try {
      const thread = await api.acceptTask(threadId, chip.id);
      void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    } catch (error) {
      console.error("accept task", error);
    } finally {
      setPending(false);
    }
  };

  const dismiss = async () => {
    setPending(true);
    try {
      await api.dismissTask(threadId, chip.id);
    } catch (error) {
      console.error("dismiss task", error);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      data-testid="task-chip"
      data-status={chip.status}
      className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-dashed border-border p-2.5 text-sm data-[status=dismissed]:opacity-60"
    >
      <ListPlus aria-hidden className="mt-0.5 size-4 shrink-0 text-highlight" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{chip.title}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{chip.prompt}</p>
        {chip.reason === undefined ? null : (
          <p data-testid="task-chip-reason" className="mt-1 text-xs text-muted-foreground">
            Why: {chip.reason}
          </p>
        )}
        <p
          data-testid="task-chip-where"
          className="mt-1 flex items-center gap-1 font-mono text-xs text-muted-foreground"
        >
          <GitBranch aria-hidden className="size-3" />
          {taskStartLabel(taskStart(chip, git))}
        </p>
      </div>
      {chip.status === "offered" ? (
        <div className="flex shrink-0 gap-1">
          <Button size="xs" onClick={() => void accept()} disabled={pending}>
            Start thread
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void dismiss()} disabled={pending}>
            Dismiss
          </Button>
        </div>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">
          {chip.status === "accepted" ? "Started" : "Dismissed"}
        </span>
      )}
    </div>
  );
}
