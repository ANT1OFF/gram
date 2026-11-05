import type { WaitViewKind, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Eye,
  Footprints,
  Hand,
  ListChecks,
  MessageCircleQuestion,
  PenLine,
  Scale,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useThreadsStore } from "@/stores/threads";

import { holdAnswer, type SendAction } from "./ask-answer";
import type { AskOption } from "./ask-model";
import { useAskStackStore } from "./ask-stack-store";
import { saveSetAside, SNOOZE_MS } from "./inbox-set-aside";
import type { NeedsYouItem } from "./needs-you-items";

// What the Inbox draws and does for a Needs you item beyond its answer form: the kind's glyph and
// words, a section's heading, the Undo line, and the item's actions. Every answer goes through its
// source's own path: an ask's through `holdAnswer` with Undo, a wait's Done through `resolveWait`, a
// dismissed failure into `inbox.cleared` and Later into `inbox.snoozed`.

const WAIT_ICONS: Partial<Record<WaitViewKind, LucideIcon>> = {
  draft: PenLine,
  review: Eye,
  decision: Scale,
  action: Footprints,
};

const WAIT_LABELS: Partial<Record<WaitViewKind, string>> = {
  draft: "Draft to send",
  review: "Review",
  decision: "Decision",
  action: "Step to take",
};

/** The kind's glyph and the words behind it. */
export const kindOf = (
  item: NeedsYouItem,
): { readonly icon: LucideIcon; readonly label: string } => {
  switch (item.kind) {
    case "approval":
      return { icon: ShieldQuestion, label: "Approval" };
    case "plan":
      return { icon: ListChecks, label: "Plan to review" };
    case "question":
      return {
        icon: MessageCircleQuestion,
        label:
          item.ask?.worker !== undefined
            ? "Worker question"
            : item.ask?.memory !== undefined
              ? "Orchestrator question"
              : "Question",
      };
    case "wait": {
      const kind = item.wait?.view.kind;
      return {
        icon: (kind === undefined ? undefined : WAIT_ICONS[kind]) ?? Hand,
        label: (kind === undefined ? undefined : WAIT_LABELS[kind]) ?? "Waiting on you",
      };
    }
    case "failure":
      return {
        icon: CircleAlert,
        label: item.owned ? "Failing" : "Failing, no live worker",
      };
    case "watch":
      return { icon: Eye, label: "Watch PR stopped" };
  }
};

/** Whether Dismiss applies: a failure or a stopped watch until it recurs, or a worker's question. */
export const canDismiss = (item: NeedsYouItem): boolean =>
  item.kind === "failure" || item.kind === "watch" || item.ask?.worker !== undefined;

/** What a row's buttons do, each through its source's own path. */
export function useNeedsYouActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const save = useSaveSettings();
  const hold = useAskStackStore((s) => s.hold);
  const onMemory = (workspaceId: WorkspaceId) => {
    void queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", workspaceId] });
  };
  return {
    answer: (item: NeedsYouItem, option: AskOption) => {
      const { ask } = item;
      const { action } = option;
      if (ask === undefined || action.kind === "open" || action.kind === "board") return;
      holdAnswer(api, ask, option.done, action satisfies SendAction, onMemory);
    },
    done: (item: NeedsYouItem) => {
      if (item.wait === undefined || item.threadId === undefined) return;
      void api
        .resolveWait(item.threadId, item.wait.item.id)
        .catch((error: unknown) => console.error("needs you: done", error));
    },
    later: (item: NeedsYouItem) => {
      const now = Date.now();
      void saveSetAside(save, item.ids, { snoozeUntil: now + SNOOZE_MS, now }).catch(
        (error: unknown) => console.error("needs you: later", error),
      );
    },
    wake: (item: NeedsYouItem) =>
      void saveSetAside(save, item.ids, "unsnooze").catch((error: unknown) =>
        console.error("needs you: wake", error),
      ),
    dismiss: (item: NeedsYouItem) => {
      const worker = item.ask?.worker;
      if (worker !== undefined) {
        hold({ key: item.key, ids: item.ids, done: "Dismissed" }, () =>
          api
            .dismissWorkerQuestion({
              workspaceId: worker.workspaceId,
              questionId: worker.question.id,
            })
            .then(
              () => {
                onMemory(worker.workspaceId);
                return {};
              },
              (error: unknown) => ({ failed: item.ids, problem: errorMessage(error) }),
            ),
        );
        return;
      }
      if (item.kind !== "failure" && item.kind !== "watch") return;
      hold({ key: item.key, ids: item.ids, done: "Dismissed" }, () =>
        saveSetAside(save, item.ids, "clear").then(
          () => ({}),
          (error: unknown) => ({ failed: item.ids, problem: errorMessage(error) }),
        ),
      );
    },
    /** Turns Watch PR back on for a stopped watch, keeping its round budget. */
    resume: (item: NeedsYouItem) => {
      if (item.threadId === undefined) return;
      const budget = useThreadsStore.getState().byId[item.threadId]?.thread.babysit?.budget;
      void api
        .threadSetBabysit(item.threadId, true, budget)
        .catch((error: unknown) => console.error("needs you: resume watch", error));
    },
  };
}

/** A section's heading in the Inbox's list: its kind, and how many. */
export function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="flex items-center gap-2 px-2 pt-2.5 pb-1 text-meta font-semibold text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-normal tabular-nums">{count}</span>
    </h3>
  );
}

/** The newest answer still held, with Undo: an answer from the Inbox can be taken back. */
export function NeedsYouUndo({ className }: { className?: string }) {
  const held = useAskStackStore((s) => s.held);
  const undo = useAskStackStore((s) => s.undo);
  const last = held.at(-1);
  if (last === undefined) return null;
  return (
    <div
      data-testid="needs-you-undo-line"
      className={cn("flex items-center gap-2 px-2 text-meta text-muted-foreground", className)}
    >
      <Check aria-hidden className="size-3.5 text-success" />
      <span className="min-w-0 flex-1 truncate">{last.done}</span>
      <Button size="xs" variant="ghost" data-testid="needs-you-undo" onClick={() => undo(last.key)}>
        Undo
      </Button>
    </div>
  );
}
