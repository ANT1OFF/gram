import type { ThreadId } from "@gram/contracts";
import {
  ListChecks,
  MessageCircleQuestion,
  ShieldQuestion,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { useEffect, useId } from "react";

import { Button } from "@/components/ui/button";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { Dialog } from "@/thread/dialog-shell";
import { RequestCards, SheetRequestCards } from "@/thread/request-cards";

import type { Ask } from "./ask-model";
import { useAskSheet } from "./ask-sheet-store";
import { useOpenThread, useWorkspaceAsks } from "./ask-stack";
import { memoryQuestionCard, workerQuestionCard } from "./question-card-model";
import { OpenQuestion, useMemoryQuestionAnswer, useWorkerQuestionActions } from "./question-entry";

// The ask sheet (ask-sheet-store.ts): one ask from the Asks dock, read in full and answered, over
// the right of the window. Its text scrolls; its answer row sticks to the bottom edge, so a choice
// or a Send is never below the fold. It answers through the ask's own path, as its card would, and
// closes once the ask is gone.

const TEST_ID = "ask-sheet";

const KIND = {
  approval: { icon: ShieldQuestion, label: "Approval" },
  question: { icon: MessageCircleQuestion, label: "Question" },
  plan: { icon: ListChecks, label: "Plan to review" },
} as const;

/** The thread an ask's "Open thread" goes to: who asked. */
const askerOf = (ask: Ask, orchestratorId: ThreadId | undefined): ThreadId | undefined =>
  ask.worker?.question.threadId ??
  (ask.memory === undefined ? ask.group?.entries[0]?.threadId : orchestratorId);

function MemoryQuestionSheet({
  memory,
  orchestratorId,
}: {
  memory: NonNullable<Ask["memory"]>;
  orchestratorId: ThreadId | undefined;
}) {
  const answer = useMemoryQuestionAnswer(memory.workspaceId);
  return (
    <OpenQuestion
      card={memoryQuestionCard(memory.question, 0, orchestratorId)}
      compact={false}
      sheet
      unavailable={
        orchestratorId === undefined
          ? "Open the orchestrator first: the answer is a message to it"
          : undefined
      }
      onAnswer={answer(memory.question)}
    />
  );
}

function WorkerQuestionSheet({ worker }: { worker: NonNullable<Ask["worker"]> }) {
  const actions = useWorkerQuestionActions(worker.workspaceId);
  return (
    <OpenQuestion
      card={workerQuestionCard(worker.question)}
      compact={false}
      sheet
      onAnswer={actions.answer(worker.question)}
      onDismiss={actions.dismiss(worker.question)}
    />
  );
}

function SheetContent({ ask, orchestratorId }: { ask: Ask; orchestratorId: ThreadId | undefined }) {
  if (ask.memory !== undefined) {
    return <MemoryQuestionSheet memory={ask.memory} orchestratorId={orchestratorId} />;
  }
  if (ask.worker !== undefined) return <WorkerQuestionSheet worker={ask.worker} />;
  // A request is answered by its own card, the one its thread shows, drawn for the sheet.
  const first = ask.group?.entries[0];
  if (first === undefined) return null;
  return (
    <SheetRequestCards>
      <RequestCards threadId={first.threadId} requests={[first.request]} focused={false} />
    </SheetRequestCards>
  );
}

/** The ask sheet, mounted once. Esc, the close button or the ask being answered closes it. */
export function AskSheet() {
  const target = useAskSheet((s) => s.target);
  const close = useAskSheet((s) => s.close);
  const all = useWorkspaceAsks();
  const workspace =
    target === undefined ? undefined : all.find((w) => w.workspaceId === target.workspaceId);
  const ask =
    target === undefined ? undefined : workspace?.asks.find((each) => each.ids.includes(target.id));
  const open = ask !== undefined;
  const opener = useOpener(open);
  const titleId = useId();
  const openThread = useOpenThread();
  // Answered here or anywhere else, it is gone: so is its sheet.
  useEffect(() => {
    if (target !== undefined && ask === undefined) close();
  }, [target, ask, close]);
  const kind = ask === undefined ? undefined : KIND[ask.icon];
  const asker = ask === undefined ? undefined : askerOf(ask, workspace?.orchestratorThreadId);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={TEST_ID}
          data-surface="overlay"
          data-ask={ask?.key}
          aria-labelledby={titleId}
          finalFocus={returnFocusTo(opener)}
          className="fixed inset-y-2 end-2 z-50 flex w-[min(32rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out) data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0"
        >
          {ask !== undefined && kind !== undefined && (
            <>
              <header className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
                <kind.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-status-needs" />
                <div className="min-w-0 flex-1">
                  <Dialog.Title id={titleId} className="text-[15px] font-medium">
                    {kind.label}
                  </Dialog.Title>
                  {ask.context !== "" && (
                    <p
                      data-testid="ask-sheet-context"
                      className="text-xs break-words text-muted-foreground"
                    >
                      {ask.context}
                    </p>
                  )}
                </div>
                {asker !== undefined && (
                  <Button
                    size="xs"
                    variant="ghost"
                    data-testid="ask-sheet-open-thread"
                    onClick={() => {
                      close();
                      openThread(asker);
                    }}
                  >
                    Open thread
                    <SquareArrowOutUpRight aria-hidden data-icon="inline-end" />
                  </Button>
                )}
                <Dialog.Close
                  render={
                    <Button size="icon-xs" variant="ghost" aria-label="Close" title="Close" />
                  }
                >
                  <X aria-hidden />
                </Dialog.Close>
              </header>
              {/* The only scroller: the answer row inside sticks to its bottom edge. */}
              <div
                data-testid="ask-sheet-body"
                className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-1"
              >
                <SheetContent ask={ask} orchestratorId={workspace?.orchestratorThreadId} />
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
