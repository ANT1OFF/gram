import type { DiffFile, HostedThreadMoved, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleDashed } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";
import { type MoveTarget, targetKey } from "@/orchestration/move-targets";
import { FILE_STATUS } from "@/panels/diff-files";
import { threadWorking } from "@/orchestration/tree-model";
import { useThreadsStore } from "@/stores/threads";

import { Dialog, DialogShell } from "./dialog-shell";
import {
  chosenTarget,
  goesLines,
  type MoveStage,
  moveSteps,
  staysLines,
} from "./move-thread-model";
import { stopTurn } from "./stop-store";
import {
  type ExportedThread,
  exportThread,
  settleThread,
  ThreadTransferError,
} from "./thread-transfer-api";
import { useThreadMove } from "./use-thread-move";

const machine = () => (window.gram?.platform === "darwin" ? "this Mac" : "this computer");

const ignore = () => {};

const wordsOf = (error: unknown, fallback: string): string =>
  error instanceof ThreadTransferError ? error.message : fallback;

type Moved = Extract<HostedThreadMoved, { ok: true }> & {
  readonly left: readonly string[];
  readonly unsettled?: string;
};

/**
 * Moves one thread to a workspace of a server signed in to, in three faces of one sheet: what goes
 * and what stays, the move under way, and where it carries on. Its turn ends first; the server's
 * rules apply there from the move on, and the copy here stays, read-only. Nothing is deleted.
 */
export function MoveThreadDialog({
  threadId,
  onClose,
}: {
  threadId: ThreadId;
  onClose: () => void;
}) {
  const api = useApi();
  const { mover, targets } = useThreadMove();
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const working = useThreadsStore((s) => {
    const each = s.byId[threadId];
    return each !== undefined && threadWorking(each, s.statusDetail[threadId]);
  });
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const [picked, setPicked] = useState<string>();
  const target = chosenTarget(targets, picked);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const { data: edits, isPending: readingEdits } = useQuery({
    queryKey: ["git.diff", threadId, "uncommitted", git?.changesToken ?? null, "move"],
    queryFn: () => api.gitDiff(threadId, { kind: "uncommitted" }),
    retry: false,
  });
  const [phase, setPhase] = useState<"review" | "waiting" | "moving" | "moved">("review");
  const [stage, setStage] = useState<MoveStage>("export");
  const [error, setError] = useState<{ readonly why: string; readonly unknown: boolean }>();
  const [moved, setMoved] = useState<Moved>();
  const started = useRef(false);
  const unanswered = useRef<ExportedThread>(undefined);

  const move = async () => {
    if (mover === undefined || target === undefined || started.current) return;
    started.current = true;
    setError(undefined);
    setPhase("moving");
    setStage("export");
    try {
      const exported = unanswered.current ?? (await exportThread(threadId));
      unanswered.current = undefined;
      setStage("send");
      const sent = await mover(target.origin, target.workspace, exported.bundle).catch(
        (): HostedThreadMoved => ({ ok: false, why: "The move stopped unexpectedly." }),
      );
      if (!sent.ok) {
        if (sent.unknown === true) unanswered.current = exported;
        setError({ why: sent.why, unknown: sent.unknown === true });
        setPhase("review");
        return;
      }
      setStage("settle");
      const to = `${target.name} on ${target.host}`;
      const unsettled = await settleThread({
        threadId,
        exportedAt: exported.exportedAt,
        to,
        ...(sent.url === undefined ? {} : { url: sent.url }),
        server: { origin: target.origin, workspaceId: target.workspace },
      }).then(
        () => undefined,
        (failed: unknown) => wordsOf(failed, "The copy here couldn't be made read-only."),
      );
      setMoved({
        ...sent,
        left: exported.notes,
        ...(unsettled === undefined ? {} : { unsettled }),
      });
      setPhase("moved");
    } catch (failed) {
      setError({ why: wordsOf(failed, "The move stopped unexpectedly."), unknown: false });
      setPhase("review");
    } finally {
      started.current = false;
    }
  };

  useEffect(() => {
    if (phase !== "waiting") return undefined;
    const atRest = () => {
      const state = useThreadsStore.getState();
      const each = state.byId[threadId];
      if (each === undefined || !threadWorking(each, state.statusDetail[threadId])) void move();
    };
    queueMicrotask(atRest);
    return useThreadsStore.subscribe(atRest);
  });

  if (summary === undefined || mover === undefined || targets.length === 0) return null;
  const { thread } = summary;
  const title = thread.title;
  const repository =
    git?.origin ?? projects.find((each) => each.id === thread.projectId)?.name ?? "its repository";

  if (phase === "moved" && moved !== undefined && target !== undefined) {
    return (
      <DialogShell
        testId="move-thread-dialog"
        title={`"${title}" moved to ${target.name}`}
        description={`It carries on there, on ${target.organisation}'s account and under its rules.`}
        onClose={onClose}
      >
        <ul data-testid="move-thread-after" className="flex flex-col gap-2 text-reading">
          <li className="flex flex-col gap-0.5">
            {moved.unsettled === undefined ? "This copy is read-only" : "This copy is still open"}
            <span
              className={cn(
                "text-meta",
                moved.unsettled === undefined ? "text-muted-foreground" : "text-warning-text",
              )}
            >
              {moved.unsettled === undefined
                ? `Its folder stays on ${machine()}. Nothing was deleted.`
                : `${moved.unsettled} Carry on in ${target.name}, not here.`}
            </span>
          </li>
          {[...moved.notes, ...moved.left].map((note, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- notes may repeat; they never move.
            <li key={index} className="text-meta text-muted-foreground">
              {note}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Done
          </Dialog.Close>
          {moved.url !== undefined && (
            <Button
              type="button"
              size="sm"
              data-testid="move-thread-open"
              onClick={() => window.open(moved.url, "_blank", "noopener")}
            >
              Open in {target.name}
            </Button>
          )}
        </div>
      </DialogShell>
    );
  }

  if (phase === "moving" && target !== undefined) {
    return (
      <DialogShell
        testId="move-thread-dialog"
        title={`Moving "${title}" to ${target.name}`}
        onClose={ignore}
      >
        <ol data-testid="move-thread-steps" className="flex flex-col gap-2 text-reading">
          {moveSteps(stage, target).map((step) => (
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
                <Spinner aria-hidden className="size-icon-row" />
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
        <p className="text-meta text-muted-foreground">
          Nothing changes here until the server has it.
        </p>
      </DialogShell>
    );
  }

  const waiting = phase === "waiting";
  return (
    <DialogShell
      testId="move-thread-dialog"
      title={`Move "${title}" to a server`}
      onClose={onClose}
    >
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        {targets.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <p id="move-thread-to-label" className="text-meta text-muted-foreground">
              Choose where it goes
            </p>
            <RadioGroup<string>
              testId="move-thread-to"
              labelledBy="move-thread-to-label"
              value={target === undefined ? undefined : targetKey(target)}
              disabled={waiting}
              onChange={setPicked}
              options={targets.map((each) => ({
                value: targetKey(each),
                label: (
                  <>
                    {each.name} on {each.host}
                    <span className="text-muted-foreground"> · {each.organisation}</span>
                  </>
                ),
              }))}
            />
          </div>
        ) : null}
        <Listed
          testId="move-thread-goes"
          title="Goes"
          lines={goesLines(
            thread.checkout.branch === undefined ? {} : { branch: thread.checkout.branch },
          )}
        />
        <p data-testid="move-thread-stays" className="flex flex-col gap-1 text-meta">
          <span className="text-muted-foreground">Stays on {machine()}</span>
          <span>{staysLines(machine()).join(" · ")}</span>
        </p>
        {working && (
          <p data-testid="move-thread-running" className="flex flex-col gap-0.5 text-reading">
            {waiting ? "It moves when this turn ends" : "It is working now"}
            <span className="text-meta text-muted-foreground">
              It moves once this turn ends, or stop it now and it is told what was cut off.
            </span>
          </p>
        )}
      </div>
      <Destination
        target={target}
        repository={repository}
        edits={edits?.repo === true ? (edits.files ?? []) : undefined}
        reading={readingEdits}
        unpushed={git?.aheadUpstream ?? 0}
      />
      {error !== undefined && (
        <div role="alert" data-testid="move-thread-error" className="flex flex-col gap-0.5">
          <p className="text-reading text-destructive">
            {error.unknown
              ? "The server didn't say whether it took it."
              : "The move didn't finish."}{" "}
            {error.why}
          </p>
          <p className="text-meta text-muted-foreground">
            {error.unknown
              ? `It may be on ${target?.name ?? "the server"} already. Try again before you carry on here: if it got there, the server answers with that thread and this copy becomes read-only.`
              : `Nothing changed here: the thread is still on ${machine()} and you can keep working in it.`}
          </p>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        {working && !waiting && target !== undefined && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="move-thread-stop"
            onClick={() => {
              setPhase("waiting");
              void stopTurn(api, threadId);
            }}
          >
            Stop and move
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          data-testid="move-thread-start"
          disabled={waiting || target === undefined}
          onClick={() => (working ? setPhase("waiting") : void move())}
        >
          {target === undefined
            ? "Choose where it goes"
            : working
              ? "Move when this turn ends"
              : error === undefined
                ? `Move to ${target.name}`
                : "Try again"}
        </Button>
      </div>
    </DialogShell>
  );
}

const FILES_LISTED_AT_MOST = 6;

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

function Destination({
  target,
  repository,
  edits,
  reading,
  unpushed,
}: {
  target: MoveTarget | undefined;
  repository: string;
  edits: readonly DiffFile[] | undefined;
  reading: boolean;
  unpushed: number;
}) {
  const shown = edits?.slice(0, FILES_LISTED_AT_MOST) ?? [];
  const more = (edits?.length ?? 0) - shown.length;
  const additions = edits?.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = edits?.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  return (
    <section
      data-testid="move-thread-destination"
      aria-label="Before you move"
      className="flex shrink-0 flex-col gap-3 rounded-lg border border-edge-group bg-card p-3 text-reading"
    >
      <div data-testid="move-thread-where" className="flex flex-col gap-0.5">
        <span className="text-meta text-muted-foreground">Goes to</span>
        {target === undefined ? (
          <span className="text-muted-foreground">
            No workspace chosen yet. Nothing moves until you choose one.
          </span>
        ) : (
          <>
            <span className="font-medium">
              {target.name} on {target.host}
            </span>
            <span className="text-meta text-muted-foreground">
              {target.organisation}'s workspace. Its rules, models, limits and audit apply there
              from the move on. This copy stays here, read-only.
            </span>
          </>
        )}
      </div>
      <div data-testid="move-thread-ref" className="flex flex-col gap-1.5">
        <span className="text-meta text-muted-foreground">Who can read its edits</span>
        <span>
          Anyone who can read <span className="font-mono">{repository}</span>. Its edits go on a
          hidden ref there, not on a branch.
        </span>
        {reading ? (
          <span className="text-meta text-muted-foreground">Reading its edits…</span>
        ) : edits === undefined ? (
          <span className="text-meta text-muted-foreground">
            Its uncommitted edits couldn't be listed here. Any it has go there too.
          </span>
        ) : edits.length === 0 ? (
          <span className="text-meta text-muted-foreground">It has no uncommitted edits.</span>
        ) : (
          <>
            <span className="text-meta text-muted-foreground">
              {plural(edits.length, "uncommitted file goes", "uncommitted files go")} there:{" "}
              <span className="font-mono tabular-nums">
                <span className="text-success">+{additions.toLocaleString("en")}</span>{" "}
                <span className="text-destructive">−{deletions.toLocaleString("en")}</span>
              </span>
            </span>
            <ul
              data-testid="move-thread-files"
              className="flex max-h-32 flex-col overflow-y-auto rounded-md border border-border/60 [&>li~li]:border-t [&>li~li]:border-border/60"
            >
              {shown.map((file) => {
                const status = FILE_STATUS[file.status];
                return (
                  <li
                    key={file.path}
                    title={`${file.path} · ${status.label}`}
                    className="flex min-w-0 items-center gap-2 px-2 py-1 text-meta"
                  >
                    <status.icon
                      aria-hidden
                      className={cn("size-icon-row shrink-0", status.tone)}
                    />
                    <span className="sr-only">{status.label}</span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    </span>
                    {(file.additions > 0 || file.deletions > 0) && (
                      <span className="shrink-0 font-mono tabular-nums">
                        {file.additions > 0 && (
                          <span className="text-success">+{file.additions}</span>
                        )}
                        {file.additions > 0 && file.deletions > 0 && " "}
                        {file.deletions > 0 && (
                          <span className="text-destructive">−{file.deletions}</span>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
              {more > 0 && (
                <li className="px-2 py-1 text-meta text-muted-foreground">
                  and {plural(more, "more file", "more files")}
                </li>
              )}
            </ul>
          </>
        )}
        {unpushed > 0 && (
          <span className="text-meta text-muted-foreground">
            So {unpushed === 1 ? "does the commit" : `do the ${unpushed} commits`} its branch has
            that {repository} hasn't got yet.
          </span>
        )}
      </div>
    </section>
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
