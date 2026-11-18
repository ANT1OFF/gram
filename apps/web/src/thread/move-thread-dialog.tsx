import type { HostedThreadMoved, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleDashed } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";
import { targetKey } from "@/orchestration/move-targets";
import { threadWorking } from "@/orchestration/tree-model";
import { useThreadsStore } from "@/stores/threads";

import { Dialog, DialogShell } from "./dialog-shell";
import { goesLines, type MoveStage, moveSteps, staysLines } from "./move-thread-model";
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
  /** What the export left behind, in this Gram's words. */
  readonly left: readonly string[];
  /** Why the copy here isn't read-only, when settling it failed. */
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
  const target = targets.find((each) => targetKey(each) === picked) ?? targets[0];
  const [phase, setPhase] = useState<"review" | "waiting" | "moving" | "moved">("review");
  const [stage, setStage] = useState<MoveStage>("export");
  const [error, setError] = useState<{ readonly why: string; readonly unknown: boolean }>();
  const [moved, setMoved] = useState<Moved>();
  const started = useRef(false);
  // A send with no clear answer is sent again as it was: the same export answers the same thread.
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

  // "Move when this turn ends": the move starts once the thread is at rest.
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

  if (summary === undefined || mover === undefined || target === undefined) return null;
  const { thread } = summary;
  const title = thread.title;
  const repository = projects.find((each) => each.id === thread.projectId)?.name;

  if (phase === "moved" && moved !== undefined) {
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

  if (phase === "moving") {
    return (
      <DialogShell
        testId="move-thread-dialog"
        title={`Moving "${title}" to ${target.name}`}
        // Closing would hide a move under way; it ends on its own, either way.
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
      <div className="flex flex-col gap-1">
        <label htmlFor="move-thread-to" className="text-meta text-muted-foreground">
          To
        </label>
        {targets.length > 1 ? (
          <select
            id="move-thread-to"
            data-testid="move-thread-to"
            value={targetKey(target)}
            disabled={waiting}
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
          <p id="move-thread-to" data-testid="move-thread-to" className="text-reading">
            {target.name} · {target.host}
            <span className="block text-meta text-muted-foreground">{target.organisation}</span>
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Listed
          testId="move-thread-goes"
          title="Goes"
          lines={goesLines({
            ...(repository === undefined ? {} : { repository }),
            ...(thread.checkout.branch === undefined ? {} : { branch: thread.checkout.branch }),
          })}
        />
        <Listed
          testId="move-thread-stays"
          title={`Stays on ${machine()}`}
          lines={staysLines(machine())}
        />
      </div>
      {working && (
        <p data-testid="move-thread-running" className="flex flex-col gap-0.5 text-reading">
          {waiting ? "It moves when this turn ends" : "It is working now"}
          <span className="text-meta text-muted-foreground">
            It moves once this turn ends, or stop it now and it is told what was cut off.
          </span>
        </p>
      )}
      <p className="text-meta text-muted-foreground">
        From the move on, {target.organisation}'s rules apply there: its models, its limits and its
        audit, which records the move. This copy stays here, read-only.
      </p>
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
              ? `It may be on ${target.name} already. Try again before you carry on here: if it got there, the server answers with that thread and this copy becomes read-only.`
              : `Nothing changed here: the thread is still on ${machine()} and you can keep working in it.`}
          </p>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        {working && !waiting && (
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
          disabled={waiting}
          onClick={() => (working ? setPhase("waiting") : void move())}
        >
          {working
            ? "Move when this turn ends"
            : error === undefined
              ? `Move to ${target.name}`
              : "Try again"}
        </Button>
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
