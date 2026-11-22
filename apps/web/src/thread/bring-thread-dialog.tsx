import type { ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleDashed } from "lucide-react";
import { useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";
import { useThreadsStore } from "@/stores/threads";

import { Dialog, DialogShell } from "./dialog-shell";
import {
  type BringBackSource,
  type BringStage,
  bringBackFrom,
  bringSteps,
  comesLines,
} from "./move-thread-model";
import { importThread, settledThere, ThreadTransferError } from "./thread-transfer-api";
import { useThreadMove } from "./use-thread-move";

const machine = () => (window.gram?.platform === "darwin" ? "this Mac" : "this computer");

const ignore = () => {};

interface Brought {
  readonly notes: readonly string[];
  readonly exportedAt: number;
}

/**
 * Brings a thread that moved to a server back to this computer, in three faces of one sheet: what
 * comes and what stays, the move under way, and that it is back. The server's organisation decides
 * whether its work may leave; its refusal is shown in its words. The folder here keeps whatever
 * the person changed in it since: that goes on a branch of its own before the edits come back.
 */
export function BringThreadDialog({
  threadId,
  onClose,
}: {
  threadId: ThreadId;
  onClose: () => void;
}) {
  const api = useApi();
  const { view } = useThreadMove();
  const bridge = typeof window === "undefined" ? undefined : window.gram?.hostedDevice;
  const live = useThreadsStore((s) => s.byId[threadId]);
  const [seen, setSeen] = useState(live);
  if (live !== undefined && live !== seen) setSeen(live);
  const summary = live ?? seen;
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const [phase, setPhase] = useState<"review" | "bringing" | "back">("review");
  const [stage, setStage] = useState<BringStage>("fetch");
  const [error, setError] = useState<string>();
  const [back, setBack] = useState<Brought & { readonly unsettled?: string }>();
  const started = useRef(false);
  const unsettled = useRef<Brought>(undefined);

  const [held, setHeld] = useState<BringBackSource>();
  const from = held ?? (summary === undefined ? undefined : bringBackFrom(summary.thread, view));
  const project = projects.find((each) => each.id === summary?.thread.projectId);

  const bring = async () => {
    const fetchThread = bridge?.fetchThread;
    const settle = bridge?.settleThread;
    if (
      started.current ||
      fetchThread === undefined ||
      settle === undefined ||
      from === undefined ||
      "why" in from ||
      project === undefined
    )
      return;
    started.current = true;
    setHeld(from);
    setError(undefined);
    setPhase("bringing");
    try {
      let brought = unsettled.current;
      const here = summary?.thread;
      const backAt =
        here?.transferredTo === undefined && here?.transferredFrom?.leftOpen?.origin === from.origin
          ? here.transferredFrom.exportedAt
          : undefined;
      if (brought === undefined && backAt !== undefined)
        brought = { notes: [], exportedAt: backAt };
      if (brought === undefined) {
        setStage("fetch");
        const fetched = await fetchThread(from.origin, from.workspace, threadId).catch(() => ({
          ok: false as const,
          why: "The server didn't answer.",
        }));
        if (!fetched.ok) {
          setError(fetched.why);
          setPhase("review");
          return;
        }
        setStage("import");
        brought = await importThread({
          bundle: fetched.bundle,
          root: project.root,
          from: `${from.name} on ${from.host}`,
          server: { origin: from.origin, workspaceId: from.workspace },
        });
      }
      setStage("settle");
      const settled = await settle(from.origin, from.workspace, threadId, brought.exportedAt).catch(
        () => ({ ok: false as const, why: "The server didn't answer." }),
      );
      unsettled.current = settled.ok ? undefined : brought;
      if (settled.ok) await settledThere(threadId).catch(ignore);
      setBack({ ...brought, ...(settled.ok ? {} : { unsettled: settled.why }) });
      setPhase("back");
    } catch (failed) {
      setError(
        failed instanceof ThreadTransferError
          ? failed.message
          : "Bringing it back stopped unexpectedly.",
      );
      setPhase("review");
    } finally {
      started.current = false;
    }
  };

  if (summary === undefined || from === undefined || "why" in from) return null;
  const { title } = summary.thread;

  if (phase === "back" && back !== undefined) {
    return (
      <DialogShell
        testId="bring-thread-dialog"
        title={`"${title}" is back on ${machine()}`}
        description={`It carries on here, on your own account and rules. On ${from.name} it is a read-only copy.`}
        onClose={onClose}
      >
        <ul data-testid="bring-thread-after" className="flex flex-col gap-2 text-reading">
          {back.unsettled !== undefined && (
            <li className="flex flex-col gap-0.5">
              Its copy on {from.name} is still open
              <span className="text-meta text-warning-text">
                {back.unsettled} Carry on here, not there.
              </span>
            </li>
          )}
          {back.notes.map((note, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- notes may repeat; they never move.
            <li key={index} className="text-meta text-muted-foreground">
              {note}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          {back.unsettled !== undefined && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="bring-thread-settle"
              onClick={() => void bring()}
            >
              Try the copy there again
            </Button>
          )}
          <Dialog.Close render={<Button type="button" size="sm" />}>Open it</Dialog.Close>
        </div>
      </DialogShell>
    );
  }

  if (phase === "bringing") {
    return (
      <DialogShell testId="bring-thread-dialog" title={`Bringing "${title}" back`} onClose={ignore}>
        <ol data-testid="bring-thread-steps" className="flex flex-col gap-2 text-reading">
          {bringSteps(stage, from).map((step) => (
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
          Nothing changes on {from.name} until it is here.
        </p>
      </DialogShell>
    );
  }

  const branch = summary.thread.checkout.branch;
  return (
    <DialogShell
      testId="bring-thread-dialog"
      title={`Bring "${title}" back to ${machine()}`}
      description={`From ${from.name} · ${from.host}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-1">
        <p className="text-meta text-muted-foreground">Into</p>
        <p data-testid="bring-thread-into" className="text-reading">
          {project === undefined ? "Its repository" : project.name} on {machine()}
          <span className="block text-meta text-muted-foreground">
            Anything you changed in its folder since it left goes on a branch of its own first.
          </span>
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Listed
          testId="bring-thread-comes"
          title="Comes"
          lines={comesLines(branch === undefined ? {} : { branch })}
        />
        <Listed
          testId="bring-thread-stays"
          title={`Stays on ${from.name}`}
          lines={[
            "Its organisation's connections and model account",
            "A read-only copy of the thread",
          ]}
        />
      </div>
      <p className="text-meta text-muted-foreground">
        Whether work may leave {from.name} is its organisation's to say, and its audit records that
        the thread came here. From then on, your own models and rules apply.
      </p>
      {error !== undefined && (
        <div role="alert" data-testid="bring-thread-error" className="flex flex-col gap-0.5">
          <p className="text-reading text-destructive">It didn't come back. {error}</p>
          <p className="text-meta text-muted-foreground">
            Nothing changed on {from.name}: it carries on there as it was.
          </p>
        </div>
      )}
      {project === undefined && (
        <p className="text-meta text-warning-text">
          Its repository isn't a project here any more. Add it again, then bring the thread back.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        <Button
          type="button"
          size="sm"
          data-testid="bring-thread-start"
          disabled={project === undefined}
          onClick={() => void bring()}
        >
          {error === undefined ? `Bring back to ${machine()}` : "Try again"}
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
