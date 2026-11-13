import type { Thread } from "@gram/contracts";
import { MoonStar, Network, Workflow, type LucideIcon } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

import {
  roleDescription,
  roleLabel,
  threadRoleOf,
  type ThreadRoleInfo,
} from "./orchestration-model";

/**
 * The orchestrator's accent (`orchestrator`, the palette's second accent), on its glyph wherever a
 * thread, a card or a choice is one: it says who leads, as a provider's colour says whose a mark
 * is. A worker and a memory update stay in the colour around them.
 */
export const ROLE_TONE: Record<ThreadRoleInfo["kind"], string> = {
  orchestrator: "text-orchestrator",
  worker: "",
  dream: "",
};

export const ROLE_ICON: Record<ThreadRoleInfo["kind"], LucideIcon> = {
  orchestrator: Network,
  worker: Workflow,
  dream: MoonStar,
};

const ROLE_NAME: Record<ThreadRoleInfo["kind"], string> = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  dream: "Memory update",
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
        "inline-flex max-w-48 shrink-0 items-center gap-1 rounded-sm border border-border px-1 text-meta font-normal text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden className={cn("size-icon-row shrink-0", ROLE_TONE[info.role.kind])} />
      <span className="truncate">{info.label}</span>
    </span>
  );
}

/**
 * The role as a glyph before a pane's title, with its sentence in the tooltip. Nothing for a plain
 * thread. `spoken`: its name for a screen reader only, where the place already says the role (the
 * title bar's Chat, beside the workspace's switcher, is the orchestrator's chat).
 */
export function RoleGlyph({
  thread,
  testId,
  spoken = false,
}: {
  thread: Pick<Thread, "role" | "spawnedBy">;
  testId: string;
  spoken?: boolean;
}) {
  const info = useThreadRole(thread);
  if (info === undefined) return null;
  if (spoken) {
    return (
      <span data-testid={testId} data-spoken="" className="sr-only">
        {info.name}
      </span>
    );
  }
  const Icon = ROLE_ICON[info.role.kind];
  return (
    <Hint
      label={info.description}
      side="bottom"
      render={
        <span
          data-testid={testId}
          // Muted as the chrome's other glyphs are, but for the orchestrator's, which takes its
          // accent.
          className={cn("flex shrink-0 text-muted-foreground", ROLE_TONE[info.role.kind])}
        />
      }
    >
      {/* A header's mark, so a chrome glyph. */}
      <Icon aria-hidden className="size-icon-row" />
      <span className="sr-only">{info.name}</span>
    </Hint>
  );
}
