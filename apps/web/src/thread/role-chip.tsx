import type { Thread } from "@gram/contracts";
import { Moon, Network, Workflow, type LucideIcon } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

import {
  roleDescription,
  roleLabel,
  threadRoleOf,
  type ThreadRoleInfo,
} from "./orchestration-model";

export const ROLE_ICON: Record<ThreadRoleInfo["kind"], LucideIcon> = {
  orchestrator: Network,
  worker: Workflow,
  dream: Moon,
};

const ROLE_NAME: Record<ThreadRoleInfo["kind"], string> = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  dream: "Dream",
};

/**
 * The role, its name, its chip's words and its sentence for a thread, naming a worker's
 * orchestrator while that is open.
 */
export function useThreadRole(thread: Pick<Thread, "role" | "spawnedBy"> | undefined) {
  const spawner = thread?.spawnedBy?.threadId;
  const orchestratorTitle = useThreadsStore((s) =>
    spawner === undefined ? undefined : s.byId[spawner]?.thread.title,
  );
  const role = thread === undefined ? undefined : threadRoleOf(thread);
  if (role === undefined) return undefined;
  return {
    role,
    name: ROLE_NAME[role.kind],
    label: roleLabel(role),
    description: roleDescription(role, orchestratorTitle),
  };
}

/**
 * "Orchestrator" or "Worker · feature" as a small chip, for the approval cards, where a card from a
 * thread nobody is watching has to stand out. Nothing for a plain thread.
 */
export function RoleChip({
  thread,
  testId,
  className,
}: {
  thread: Pick<Thread, "role" | "spawnedBy"> | undefined;
  testId: string;
  className?: string;
}) {
  const info = useThreadRole(thread);
  if (info === undefined) return null;
  const Icon = ROLE_ICON[info.role.kind];
  return (
    <span
      data-testid={testId}
      title={info.description}
      className={cn(
        "inline-flex max-w-48 shrink-0 items-center gap-1 rounded-sm border border-border px-1 text-xs font-normal text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{info.label}</span>
    </span>
  );
}

/**
 * The role as a glyph before a pane's title, with its sentence in the tooltip. Nothing for a plain
 * thread.
 */
export function RoleGlyph({
  thread,
  testId,
}: {
  thread: Pick<Thread, "role" | "spawnedBy">;
  testId: string;
}) {
  const info = useThreadRole(thread);
  if (info === undefined) return null;
  const Icon = ROLE_ICON[info.role.kind];
  return (
    <Hint
      label={info.description}
      side="bottom"
      render={
        <span
          data-testid={testId}
          className={cn(
            "flex shrink-0",
            info.role.kind === "orchestrator" ? "text-primary" : "text-muted-foreground",
          )}
        />
      }
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{info.name}</span>
    </Hint>
  );
}
