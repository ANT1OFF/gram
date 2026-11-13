import {
  autonomyOf,
  embeddingOn,
  type HostedDeviceView,
  type HostedMoveCheck,
  type HostedMoveDone,
  type HostedMoveProgress,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDashed, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ui/meter";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import {
  autonomyNote,
  goesLines,
  movedLine,
  moveSteps,
  moveTargets,
  repositoryLine,
  runningNote,
  sentShare,
  sentText,
  STAYS_LINES,
  targetKey,
  type MoveTarget,
} from "./move-workspace-model";
import { workingWorkerThreads } from "./tree-model";
import { useWorkspaces } from "./use-orchestration";

type Bridge = NonNullable<NonNullable<Window["gram"]>["hostedDevice"]>;
type Mover = NonNullable<Bridge["move"]>;

const machine = () => (window.gram?.platform === "darwin" ? "this Mac" : "this computer");

/**
 * Where a workspace of this machine can move, and the shell's calls that move it: none unless the
 * hosted features are on, the desktop app can move one, and a server is signed in to.
 */
export function useMoveTargets(): {
  readonly targets: readonly MoveTarget[];
  readonly mover: Mover | undefined;
} {
  const hosted = useServerSettings((s) => s.settings !== undefined && embeddingOn(s.settings));
  const bridge = typeof window === "undefined" ? undefined : window.gram?.hostedDevice;
  const mover = hosted ? bridge?.move : undefined;
  const [view, setView] = useState<HostedDeviceView | null>();
  const read = useCallback(() => {
    if (bridge === undefined || mover === undefined) return;
    void bridge.state().then(setView, () => setView(null));
  }, [bridge, mover]);
  useEffect(() => {
    if (bridge === undefined || mover === undefined) return undefined;
    read();
    return bridge.onChange(read);
  }, [bridge, mover, read]);
  const targets = useMemo(() => (mover === undefined ? [] : moveTargets(view)), [mover, view]);
  return { targets, mover };
}

const ignore = () => {};

/**
 * Moves a workspace to a server signed in to, in three faces of one sheet: what goes and what
 * stays, with what the server says of its repositories and its autonomy; the move under way,
 * which can be cancelled until the server has it all; and where it runs now. Nothing here is
 * deleted by a move.
 */
export function MoveWorkspaceDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: WorkspaceId;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { targets, mover } = useMoveTargets();
  const state = useWorkspaces().find((each) => each.workspace.id === workspaceId);
  const [picked, setPicked] = useState<string>();
  const target = targets.find((each) => targetKey(each) === picked) ?? targets[0];
  const key = target === undefined ? undefined : targetKey(target);
  const [checked, setChecked] = useState<{ key: string; check: HostedMoveCheck }>();
  const check = checked !== undefined && checked.key === key ? checked.check : undefined;
  const [progress, setProgress] = useState<HostedMoveProgress>();
  const [phase, setPhase] = useState<"review" | "moving" | "moved">("review");
  const [done, setDone] = useState<Extract<HostedMoveDone, { ok: true }>>();
  const [error, setError] = useState<string>();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const running = useThreadsStore(
    (s) => workingWorkerThreads(s.byId, s.statusDetail, workspaceId).length,
  );
  const workers = useThreadsStore(
    (s) =>
      Object.values(s.byId).filter(
        (summary) =>
          summary?.thread.workspaceId === workspaceId &&
          summary.thread.spawnedBy?.feature !== undefined,
      ).length,
  );

  // What the server says of this workspace there, asked again for each place picked.
  useEffect(() => {
    if (mover === undefined || target === undefined || key === undefined) return undefined;
    let current = true;
    void mover.check(target.origin, target.workspace, workspaceId).then(
      (answer) => current && setChecked({ key, check: answer }),
      () =>
        current && setChecked({ key, check: { ok: false, why: "Gram couldn't ask the server." } }),
    );
    return () => {
      current = false;
    };
  }, [mover, target, key, workspaceId]);
  useEffect(() => mover?.onProgress(setProgress), [mover]);

  if (state === undefined || mover === undefined || target === undefined) return null;
  const { workspace } = state;
  const name = workspace.name;

  const start = async () => {
    setError(undefined);
    setProgress(undefined);
    setPhase("moving");
    const answer = await mover
      .start(target.origin, target.workspace, workspaceId)
      .catch((): HostedMoveDone => ({ ok: false, why: "The move stopped unexpectedly." }));
    // The export paused it here, whichever way the move ended.
    void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    if (answer.ok) {
      setDone(answer);
      setPhase("moved");
      return;
    }
    setPhase("review");
    setError(answer.cancelled === true ? undefined : answer.why);
  };

  if (phase === "moved" && done !== undefined) {
    return (
      <DialogShell
        testId="move-workspace-dialog"
        title={`${name} now runs in ${target.name}`}
        description={movedLine(done, target)}
        onClose={onClose}
      >
        <ul data-testid="move-workspace-after" className="flex flex-col gap-2 text-reading">
          <li className="flex flex-col gap-0.5">
            Here it is kept, paused
            <span className="text-meta text-muted-foreground">
              Nothing was deleted. Its worktrees stay on {machine()} until you remove them.
            </span>
          </li>
          <li className="flex flex-col gap-0.5">
            It runs on {target.host}
            <span className="text-meta text-muted-foreground">
              Open it in the browser to carry on there.
            </span>
          </li>
        </ul>
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Done
          </Dialog.Close>
          {done.url !== undefined && (
            <Button
              type="button"
              size="sm"
              data-testid="move-workspace-open"
              onClick={() => window.open(done.url, "_blank", "noopener")}
            >
              Open it
            </Button>
          )}
        </div>
      </DialogShell>
    );
  }

  if (phase === "moving") {
    const sent = sentText(progress);
    return (
      <DialogShell
        testId="move-workspace-dialog"
        title={`Moving ${name} to ${target.name}`}
        // Closing would hide a move that carries on: Cancel the move is the way out.
        onClose={ignore}
      >
        <ol data-testid="move-workspace-steps" className="flex flex-col gap-2 text-reading">
          {moveSteps(progress, running).map((step) => (
            <li
              key={step.key}
              data-step={step.key}
              data-state={step.state}
              className={cn(
                "flex items-center gap-2",
                step.state === "next" && "text-muted-foreground",
              )}
            >
              {step.state === "done" ? (
                <Check aria-hidden className="size-icon-row text-success" />
              ) : step.state === "now" ? (
                <LoaderCircle aria-hidden className="size-icon-row animate-spin" />
              ) : (
                <CircleDashed aria-hidden className="size-icon-row" />
              )}
              <span className="sr-only">
                {step.state === "done" ? "Done: " : step.state === "now" ? "Now: " : "Next: "}
              </span>
              {step.words}
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-1">
          <Meter
            value={sentShare(progress)}
            tone="neutral"
            label="Workspace sent"
            fillTestId="move-workspace-sent"
          />
          {sent !== undefined && (
            <p className="text-meta text-muted-foreground tabular-nums">{sent}</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-meta text-muted-foreground">
            Nothing changes here until the server has it all.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="move-workspace-cancel"
            disabled={progress?.stage === "settingUp"}
            onClick={() => void mover.cancel()}
          >
            Cancel the move
          </Button>
        </div>
      </DialogShell>
    );
  }

  const workersNote = runningNote(running);
  const autonomy = autonomyNote(autonomyOf(state.charter), check, target.organisation);
  const repositories =
    check?.ok === true
      ? check.repositories
      : workspace.projectIds.flatMap((id) => {
          const project = projects.find((each) => each.id === id);
          return project === undefined ? [] : [{ name: project.name, reached: undefined }];
        });
  return (
    <DialogShell
      testId="move-workspace-dialog"
      title={`Move ${name} to a server`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="move-workspace-to" className="text-meta text-muted-foreground">
          To
        </label>
        {targets.length > 1 ? (
          <select
            id="move-workspace-to"
            data-testid="move-workspace-to"
            value={key}
            onChange={(event) => setPicked(event.target.value)}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {targets.map((each) => (
              <option key={targetKey(each)} value={targetKey(each)}>
                {each.name} · {each.host} · {each.organisation}
              </option>
            ))}
          </select>
        ) : (
          <p id="move-workspace-to" data-testid="move-workspace-to" className="text-reading">
            {target.name} · {target.host}
            <span className="block text-meta text-muted-foreground">{target.organisation}</span>
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Listed testId="move-workspace-goes" title="Goes" lines={goesLines({ workers })} />
        <Listed testId="move-workspace-stays" title={`Stays on ${machine()}`} lines={STAYS_LINES} />
      </div>
      {repositories.length > 0 && (
        <ul data-testid="move-workspace-repositories" className="flex flex-col gap-1.5">
          {repositories.map((repository) => (
            <li
              key={repository.name}
              data-reached={repository.reached}
              className="flex flex-col gap-0.5 text-reading"
            >
              {repository.name}
              {repository.reached !== undefined && (
                <span
                  className={cn(
                    "text-meta",
                    repository.reached ? "text-muted-foreground" : "text-warning",
                  )}
                >
                  {repositoryLine(repository.reached, target.organisation)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {workersNote !== undefined && <Note testId="move-workspace-running" {...workersNote} />}
      {autonomy !== undefined && <Note testId="move-workspace-autonomy" {...autonomy} />}
      {check?.ok === false && (
        <p
          role="alert"
          data-testid="move-workspace-refused"
          className="text-reading text-destructive"
        >
          {check.why}
        </p>
      )}
      {error !== undefined && (
        <p
          role="alert"
          data-testid="move-workspace-error"
          className="text-reading text-destructive"
        >
          {error} Nothing was moved.
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-meta text-muted-foreground">Kept here afterwards, never deleted.</p>
        <div className="flex gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Cancel
          </Dialog.Close>
          <Button
            type="button"
            size="sm"
            data-testid="move-workspace-start"
            disabled={check?.ok !== true}
            onClick={() => void start()}
          >
            Move to {target.name}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

function Listed({
  testId,
  title,
  lines,
}: {
  testId: string;
  title: string;
  lines: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-meta text-muted-foreground">{title}</p>
      <ul data-testid={testId} className="flex list-disc flex-col gap-0.5 pl-4 text-reading">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function Note({ testId, title, line }: { testId: string; title: string; line: string }) {
  return (
    <p data-testid={testId} className="flex flex-col gap-0.5 text-reading">
      {title}
      <span className="text-meta text-muted-foreground">{line}</span>
    </p>
  );
}
