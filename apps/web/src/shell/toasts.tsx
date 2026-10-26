import type { ServerEvent, ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlert,
  CircleCheck,
  Info,
  MessageCircleQuestion,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { PresenceItem, PresenceList } from "@/motion";
import { errorMessage } from "@/api/errors";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useUndoToasts, type UndoToast } from "@/stores/undo-toasts";

import { useToastDock } from "./toast-dock";

type Notify = Extract<ServerEvent, { type: "notify" }>;

/** A key per notification that holds while toasts around it come and go, so none is remounted. */
const toastKeys = new WeakMap<object, number>();
let nextToastKey = 0;
const toastKey = (notification: object): number => {
  const known = toastKeys.get(notification);
  if (known !== undefined) return known;
  toastKeys.set(notification, ++nextToastKey);
  return nextToastKey;
};

const TOAST_MS = 6000;
const MAX_VISIBLE = 3;

const KIND: Record<Notify["kind"], { icon: LucideIcon; tone: string; label: string }> = {
  needsInput: { icon: MessageCircleQuestion, tone: "text-status-needs", label: "Needs you" },
  done: { icon: CircleCheck, tone: "text-success", label: "Done" },
  error: { icon: CircleAlert, tone: "text-destructive", label: "Error" },
  info: { icon: Info, tone: "text-info", label: "Notice" },
};

/**
 * Server `notify` events (agent notices, turn ends, errors) as a short-lived toast stack. While the
 * right panel is open the stack docks at its foot, so it shrinks the panel's content rather than
 * covering its buttons; otherwise it floats bottom-right. Escape on a toast dismisses it.
 */
export function Toasts() {
  const navigate = useNavigate();
  const notifications = useThreadsStore((s) => s.notifications);
  const dock = useToastDock((s) => s.node);
  const panelShown = useLayoutStore((s) => fitShell(s).panel !== "none");
  const [dismissed, setDismissed] = useState<ReadonlySet<object>>(() => new Set());

  const dismiss = (n: object) =>
    setDismissed(
      (prev) => new Set<object>(notifications.filter((item) => prev.has(item) || item === n)),
    );
  const listRef = useRef<HTMLOListElement>(null);
  /** What had focus before keyboard focus entered the stack. */
  const entryFocus = useRef<Element | null>(null);

  /** Dismisses a toast; focus inside it moves to the toast now in its place, else back out. */
  const dismissFocused = (n: object, item: HTMLElement, index: number) => {
    const hadFocus = item.contains(document.activeElement);
    dismiss(n);
    if (!hadFocus) return;
    setTimeout(() => {
      if (!focusLost()) return;
      const items = listRef.current?.children;
      const next = items?.[Math.min(index, items.length - 1)];
      if (!focusIfConnected(next?.querySelector("button:not(:disabled)"))) {
        focusIfConnected(entryFocus.current);
      }
    }, 0);
  };

  useEffect(() => {
    const timers = notifications
      .filter((n) => !dismissed.has(n))
      .map((n) =>
        setTimeout(
          () =>
            setDismissed(
              (prev) =>
                new Set<object>(notifications.filter((item) => prev.has(item) || item === n)),
            ),
          Math.max(0, n.at + TOAST_MS - Date.now()),
        ),
      );
    return () => timers.forEach(clearTimeout);
  }, [notifications, dismissed]);

  const undos = useUndoToasts((s) => s.toasts);
  useEffect(() => {
    const timers = undos.map((toast) =>
      setTimeout(
        () => useUndoToasts.getState().dismiss(toast),
        Math.max(0, toast.at + TOAST_MS - Date.now()),
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [undos]);

  const visible = notifications.filter((n) => !dismissed.has(n)).slice(-MAX_VISIBLE);
  const docked = panelShown && dock !== null;

  const list = (
    <ol
      ref={listRef}
      aria-live="polite"
      aria-label="Notifications"
      data-docked={docked}
      onFocus={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          entryFocus.current = event.relatedTarget;
        }
      }}
      className={
        docked
          ? "flex flex-col px-2 pt-2 empty:hidden"
          : "pointer-events-none fixed right-4 bottom-2 z-50 flex w-80 flex-col"
      }
    >
      <PresenceList>
        {visible.map((n, index) => {
          const kind = KIND[n.kind];
          const open = n.threadId
            ? () => {
                dismiss(n);
                void navigate({ to: "/t/$threadId", params: { threadId: n.threadId as ThreadId } });
              }
            : undefined;
          return (
            <PresenceItem
              as="li"
              from="right"
              key={toastKey(n)}
              data-testid="toast"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // The toast's own Escape: never an app shortcut too, such as denying an approval.
                event.preventDefault();
                event.stopPropagation();
                dismissFocused(n, event.currentTarget, index);
              }}
              // The stack's gap is each toast's own margin, so a leaving toast folds its gap away too.
              className="pointer-events-auto mb-2 flex items-start gap-2 rounded-(--radius-lg) border border-border bg-popover p-3 text-sm text-popover-foreground shadow-(--shadow-raised)"
            >
              <kind.icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", kind.tone)} />
              <button
                type="button"
                className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                disabled={!open}
                onClick={open}
              >
                <span className="sr-only">{kind.label}: </span>
                <span className="block font-medium">{n.title}</span>
                {n.body && <span className="block text-xs text-muted-foreground">{n.body}</span>}
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                className="shrink-0 rounded-sm text-muted-foreground transition-colors duration-(--dur-fast) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) => {
                  const item = event.currentTarget.closest("li");
                  if (item) dismissFocused(n, item, index);
                  else dismiss(n);
                }}
              >
                <X className="size-3.5" />
              </button>
            </PresenceItem>
          );
        })}
        {undos.slice(-MAX_VISIBLE).map((toast) => (
          <UndoItem key={toastKey(toast)} toast={toast} />
        ))}
      </PresenceList>
    </ol>
  );

  return docked ? createPortal(list, dock) : list;
}

/** A change just made, with the way back while it shows. */
function UndoItem({ toast }: { toast: UndoToast }) {
  const dismiss = () => useUndoToasts.getState().dismiss(toast);
  return (
    <PresenceItem
      as="li"
      from="right"
      data-testid="undo-toast"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
      className="pointer-events-auto mb-2 flex items-center gap-2 rounded-(--radius-lg) border border-border bg-popover p-3 text-sm text-popover-foreground shadow-(--shadow-raised)"
    >
      <span className="min-w-0 flex-1 font-medium">{toast.title}</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-sm font-medium text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          dismiss();
          toast.undo().catch((error: unknown) =>
            useThreadsStore.getState().applyEvent({
              type: "notify",
              kind: "error",
              title: "Couldn't undo",
              body: errorMessage(error),
            }),
          );
        }}
      >
        <Undo2 aria-hidden className="size-3.5" />
        Undo
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded-sm text-muted-foreground transition-colors duration-(--dur-fast) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={dismiss}
      >
        <X className="size-3.5" />
      </button>
    </PresenceItem>
  );
}
