import type { WaitViewKind, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  Check,
  CircleAlert,
  Eye,
  Hand,
  ListChecks,
  MessageCircleQuestion,
  PenLine,
  Scale,
  ShieldQuestion,
  X,
  type LucideIcon,
} from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSaveSettings } from "@/settings/use-save-settings";
import { MockThumb } from "@/thread/mock-visuals";

import { holdAnswer, type SendAction } from "./ask-answer";
import type { AskOption } from "./ask-model";
import { useAskStackStore } from "./ask-stack-store";
import { saveSetAside, SNOOZE_MS } from "./inbox-set-aside";
import { itemText, type NeedsYouItem } from "./needs-you-items";

// One row of Needs you, as the popover and the panel list it (needs-you-home mock, C Hybrid): what
// kind it is, its words, its thread and age, and the answers it takes in place. A click on its words
// opens its thread at the turn that asked. Every answer goes through its source's own path: an
// ask's through `holdAnswer` with the stack's Undo, a wait's Done through `resolveWait`, a dismissed
// failure into `inbox.cleared` and Later into `inbox.snoozed`.

const WAIT_ICONS: Partial<Record<WaitViewKind, LucideIcon>> = {
  draft: PenLine,
  review: Eye,
  decision: Scale,
  action: Hand,
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
  }
};

/** At most this many options answer from a row; more open the thread. */
const QUICK_MAX = 4;

/** The options a row answers with in place, or none when its ask must be read in full. */
const quickOptions = (item: NeedsYouItem): readonly AskOption[] => {
  const options = item.ask?.options ?? [];
  if (options.length === 0 || options.length > QUICK_MAX) return [];
  return options.every((option) => option.action.kind !== "open" && option.action.kind !== "board")
    ? options
    : [];
};

/**
 * The screenshots of a row's quick options that have one (`QuestionChoice.image`), each
 * with the number its answer button carries.
 */
export const optionThumbs = (
  item: NeedsYouItem,
): readonly { readonly number: number; readonly label: string; readonly image: string }[] => {
  const visuals = item.ask?.visuals;
  if (visuals === undefined) return [];
  return quickOptions(item).flatMap((option, index) => {
    const image = visuals.options.find((choice) => choice.label === option.label)?.image;
    return image === undefined ? [] : [{ number: index + 1, label: option.label, image }];
  });
};

/** An Allow or a Deny, drawn as a check or a cross; anything else by its number. */
const glyphOf = (option: AskOption): LucideIcon | undefined =>
  option.action.kind === "group"
    ? /^Allow\b/u.test(option.label)
      ? Check
      : /^Deny\b/u.test(option.label)
        ? X
        : undefined
    : undefined;

/** Whether Dismiss applies: a failure until it fails again, or a worker's question. */
const canDismiss = (item: NeedsYouItem): boolean =>
  item.kind === "failure" || item.ask?.worker !== undefined;

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
      if (item.kind !== "failure") return;
      hold({ key: item.key, ids: item.ids, done: "Dismissed" }, () =>
        saveSetAside(save, item.ids, "clear").then(
          () => ({}),
          (error: unknown) => ({ failed: item.ids, problem: errorMessage(error) }),
        ),
      );
    },
  };
}

const ICON_BUTTON = "size-6 text-muted-foreground hover:text-foreground";

/** A row's answers in place: its options, or Done for a wait. */
function QuickAnswers({
  item,
  actions,
}: {
  item: NeedsYouItem;
  actions: ReturnType<typeof useNeedsYouActions>;
}) {
  if (item.kind === "wait") {
    return (
      <Hint
        label="Done"
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Done: ${itemText(item)}`}
            data-testid="needs-you-done"
            className={ICON_BUTTON}
            onClick={() => actions.done(item)}
          />
        }
      >
        <Check aria-hidden className="size-3.5" />
      </Hint>
    );
  }
  return quickOptions(item).map((option, index) => {
    const Glyph = glyphOf(option);
    return (
      <Hint
        key={option.label}
        label={option.label}
        render={
          <Button
            size={Glyph === undefined ? "xs" : "icon-xs"}
            variant={Glyph === undefined ? "outline" : "ghost"}
            aria-label={`${option.label}: ${itemText(item)}`}
            data-testid="needs-you-answer"
            data-option={option.label}
            className={cn(
              Glyph === undefined ? "h-5 min-w-5 px-1 font-mono text-[11px]" : ICON_BUTTON,
            )}
            onClick={() => actions.answer(item, option)}
          />
        }
      >
        {Glyph === undefined ? index + 1 : <Glyph aria-hidden className="size-3.5" />}
      </Hint>
    );
  });
}

/** Later and Dismiss, which the panel adds to a row's answers. */
function SetAside({
  item,
  actions,
}: {
  item: NeedsYouItem;
  actions: ReturnType<typeof useNeedsYouActions>;
}) {
  return (
    <>
      <Hint
        label="Later (1 hour)"
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Later: ${itemText(item)}`}
            data-testid="needs-you-later"
            className={ICON_BUTTON}
            onClick={() => actions.later(item)}
          />
        }
      >
        <AlarmClock aria-hidden className="size-3.5" />
      </Hint>
      {canDismiss(item) && (
        <Hint
          label={item.kind === "failure" ? "Dismiss until it fails again" : "Dismiss"}
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Dismiss: ${itemText(item)}`}
              data-testid="needs-you-dismiss"
              className={ICON_BUTTON}
              onClick={() => actions.dismiss(item)}
            />
          }
        >
          <X aria-hidden className="size-3.5" />
        </Hint>
      )}
    </>
  );
}

/** A row's option screenshots, small, numbered as its answers are; a click enlarges one. */
function OptionThumbs({ item }: { item: NeedsYouItem }) {
  const thumbs = optionThumbs(item);
  const threadId = item.ask?.visuals?.threadId;
  if (thumbs.length === 0 || threadId === undefined) return null;
  return (
    <ul
      data-testid="needs-you-thumbs"
      aria-label="Options as pictures"
      className="col-start-2 col-end-4 flex gap-1.5 pt-1 pb-0.5"
    >
      {thumbs.map((thumb) => (
        <li
          key={thumb.label}
          data-testid="needs-you-thumb"
          data-option={thumb.label}
          className="relative w-16 shrink-0"
        >
          <MockThumb threadId={threadId} path={thumb.image} label={thumb.label} />
          <span
            aria-hidden
            className="pointer-events-none absolute top-0.5 left-0.5 rounded-sm bg-background/85 px-1 font-mono text-[10px] leading-4 text-foreground"
          >
            {thumb.number}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function NeedsYouRow({
  item,
  now,
  current,
  variant,
  onOpen,
  actions,
}: {
  item: NeedsYouItem;
  now: number;
  /** The item last opened from here, which the next step moves on from. */
  current: boolean;
  variant: "popover" | "panel";
  onOpen: (item: NeedsYouItem) => void;
  actions: ReturnType<typeof useNeedsYouActions>;
}) {
  const kind = kindOf(item);
  const where =
    item.owned || item.kind !== "failure" ? item.where : `${item.where} · no live worker`;
  return (
    <li
      data-testid="needs-you-item"
      data-kind={item.kind}
      data-key={item.key}
      data-thread-id={item.threadId}
      data-current={current || undefined}
      className={cn(
        "group/row grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-(--radius-md) px-2 py-1 hover:bg-muted/60 focus-within:bg-muted/60",
        current && "bg-muted/60",
      )}
    >
      <Hint
        label={kind.label}
        render={
          <span
            aria-label={kind.label}
            role="img"
            className={cn(
              "mt-0.5 flex",
              item.kind === "failure"
                ? "text-destructive"
                : item.kind === "wait"
                  ? "text-muted-foreground"
                  : "text-status-needs",
            )}
          />
        }
      >
        <kind.icon aria-hidden className="size-4" />
      </Hint>
      <button
        type="button"
        data-testid="needs-you-open"
        title={item.threadId === undefined ? "No thread to open" : `Open ${item.where} at it`}
        disabled={item.threadId === undefined}
        onClick={() => onOpen(item)}
        className="flex min-w-0 flex-col rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span className="truncate text-[13px] text-foreground">
          {item.title}
          {item.command !== undefined && (
            <>
              {" "}
              <code className="font-mono text-[12px]">{item.command}</code>
            </>
          )}
        </span>
        <span className={cn("truncate text-xs text-muted-foreground", !item.owned && "italic")}>
          {where}
        </span>
      </button>
      <span className="flex flex-col items-end gap-0.5">
        {item.at !== undefined && (
          <span className="text-[11px] leading-5 text-muted-foreground tabular-nums">
            {formatRelative(item.at, now)}
          </span>
        )}
        <span
          className={cn(
            "flex items-center gap-0.5",
            variant === "panel" &&
              "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100",
            variant === "panel" && current && "opacity-100",
          )}
        >
          <QuickAnswers item={item} actions={actions} />
          {variant === "panel" && <SetAside item={item} actions={actions} />}
        </span>
      </span>
      <OptionThumbs item={item} />
    </li>
  );
}

/** The newest answer still held, with Undo: an answer from a row can be taken back, as in the stack. */
export function NeedsYouUndo({ className }: { className?: string }) {
  const held = useAskStackStore((s) => s.held);
  const undo = useAskStackStore((s) => s.undo);
  const last = held.at(-1);
  if (last === undefined) return null;
  return (
    <div
      data-testid="needs-you-undo-line"
      className={cn("flex items-center gap-2 px-2 text-xs text-muted-foreground", className)}
    >
      <Check aria-hidden className="size-3.5 text-success" />
      <span className="min-w-0 flex-1 truncate">{last.done}</span>
      <Button size="xs" variant="ghost" data-testid="needs-you-undo" onClick={() => undo(last.key)}>
        Undo
      </Button>
    </div>
  );
}
