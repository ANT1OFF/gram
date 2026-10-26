import type { ThreadId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Brain,
  Columns3,
  Ellipsis,
  FolderPlus,
  Images,
  Pause,
  Play,
  Plus,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { cn } from "@/lib/utils";
import { ListHighlight } from "@/motion";
import { setWorkspacePaused } from "@/orchestration/pause-workspace";
import { useHandoffStore } from "@/orchestration/use-board-actions";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useViewStore } from "@/views/view-store";

import { prefillTaskTarget } from "./draft-prefill";
import { POPOVER } from "./slash-menu";
import { orchestratorVerbs, VERB_COLUMNS, type Verb, type VerbId } from "./verbs";

const ICONS: Record<VerbId, LucideIcon> = {
  task: Plus,
  pause: Pause,
  resume: Play,
  memory: Brain,
  board: Columns3,
  files: Images,
  repo: FolderPlus,
  fresh: RefreshCw,
  more: Ellipsis,
};

/** Says why a verb that calls the server failed, as the palette's commands do. */
const fail = (what: string) => (error: unknown) =>
  useThreadDialogs.getState().fail(`Couldn't ${what}: ${errorMessage(error)}`);

export interface OrchestratorVerbs {
  readonly verbs: readonly Verb[];
  run(verb: VerbId): void;
}

/**
 * The orchestrator composer's `/` verbs, each the action Gram has for it elsewhere: New task for
 * this workspace, the workspace's pause, its memory, the Board view, its Files, Add repository,
 * Fresh session, and ⌘K on the workspace's commands. `undefined` outside an orchestrator thread,
 * where the composer keeps the agent's commands.
 */
export function useOrchestratorVerbs(threadId: ThreadId): OrchestratorVerbs | undefined {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const workspaces = useWorkspaces();
  const workspaceId = thread?.role === "orchestrator" ? thread.workspaceId : undefined;
  const state = workspaces.find((each) => each.workspace.id === workspaceId);
  const paused = state === undefined ? undefined : state.paused !== undefined;
  const verbs = useMemo(() => orchestratorVerbs(paused), [paused]);
  if (workspaceId === undefined) return undefined;

  const run = (id: VerbId) => {
    switch (id) {
      case "task":
        prefillTaskTarget({ kind: "workspace", workspaceId });
        return void navigate({ to: "/new-task" });
      case "pause":
      case "resume":
        if (state === undefined) return;
        return void setWorkspacePaused(api, queryClient, state.workspace, id === "pause").catch(
          fail(id === "pause" ? "pause the workspace" : "resume the workspace"),
        );
      case "memory":
        return void navigate({ to: "/w/$workspaceId/memory", params: { workspaceId } });
      case "board": {
        const view = useViewStore.getState();
        view.setQuiet(false);
        return view.setView("board");
      }
      case "files":
        return void navigate({ to: "/w/$workspaceId/files", params: { workspaceId } });
      case "repo":
        return useThreadDialogs.getState().open({ kind: "addRepo", workspaceId });
      case "fresh":
        return useHandoffStore.getState().confirm(workspaceId);
      case "more":
        // After the key that picked it is done with the composer, so the palette's field keeps focus.
        return void setTimeout(() =>
          useLayoutStore.getState().openPalette("", { kind: "workspace", workspaceId }),
        );
    }
  };
  return { verbs, run };
}

/** The verbs as a grid of icons with a word each, no descriptions, as the design draws them. */
export function VerbMenu({
  id,
  verbs,
  activeIndex,
  onChoose,
}: {
  id: string;
  verbs: readonly Verb[];
  activeIndex: number;
  onChoose: (verb: Verb) => void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Orchestrator commands"
      data-testid="verb-menu"
      className={cn(POPOVER, "gram-pop isolate grid w-80 right-auto")}
      style={{ gridTemplateColumns: `repeat(${VERB_COLUMNS}, minmax(0, 1fr))` }}
    >
      <ListHighlight
        targetId={`${id}-${activeIndex}`}
        layout={verbs.map((v) => v.id).join("\n")}
        className="rounded-md bg-accent ring-1 ring-ring ring-inset"
      />
      {verbs.map((verb, index) => {
        const Icon = ICONS[verb.id];
        return (
          <li
            key={verb.id}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            data-verb={verb.id}
            // Keep focus in the textarea.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(verb)}
            className={cn(
              "flex cursor-default flex-col items-center gap-1 rounded-md px-1 py-2 text-xs",
              index === activeIndex && "text-accent-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            <span>{verb.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
