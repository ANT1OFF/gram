import { WAIT_BODY_MAX, type WaitItem } from "@gram/contracts";
import { Check, CircleSlash, X } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMountEffect } from "@/lib/effects";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

import { resolvedAs } from "./waiting-model";

/**
 * Under a row whose Dismiss was clicked: why it no longer makes sense, which the user may leave
 * blank. Enter dismisses, Escape steps back.
 */
export function DismissForm({
  title,
  onDismiss,
  onCancel,
}: {
  title: string;
  onDismiss: (note: string | undefined) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useMountEffect(() => field.current?.focus());
  const submit = () => onDismiss(note.trim() === "" ? undefined : note.trim());
  return (
    <form
      data-testid="waiting-dismiss-form"
      className="mt-1 flex flex-wrap items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        ref={field}
        aria-label={`Why dismiss ${title}`}
        data-testid="waiting-dismiss-note"
        placeholder="Why it no longer makes sense (optional)"
        maxLength={WAIT_BODY_MAX}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
        className="h-7 min-w-40 flex-1 text-body"
      />
      <Button type="submit" size="xs" variant="outline" data-testid="waiting-dismiss-confirm">
        Dismiss
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * How a resolved row says it ended (`resolvedAs`): a tick and the title struck through when done,
 * else what ended it and who, by you, the agent or the orchestrator by name, with why.
 */
export function Ended({ item, now }: { item: WaitItem; now: number }) {
  const as = resolvedAs(item);
  const orchestrator = useThreadsStore((s) =>
    item.resolverThread === undefined ? undefined : s.byId[item.resolverThread]?.thread.title,
  );
  if (as === undefined) return null;
  const Icon = as.ending === "done" ? Check : as.ending === "dismissed" ? X : CircleSlash;
  const who =
    as.by === "orchestrator"
      ? `by ${orchestrator ?? "the orchestrator"}`
      : as.by === "agent"
        ? "by the agent"
        : as.by === "helper"
          ? "by the helper"
          : as.ending === "done"
            ? ""
            : "by you";
  const said = as.ending === "done" ? (who === "" ? "" : `${who} · `) : `${as.ending} ${who} · `;
  return (
    <>
      <Icon
        aria-hidden
        className={cn("size-icon-row shrink-0", as.ending === "done" && "text-success")}
      />
      <span
        className={cn("min-w-0 truncate", as.ending === "done" && "line-through")}
        title={item.note}
      >
        {item.title}
        {item.note !== undefined && as.ending !== "done" && (
          <span className="text-muted-foreground"> · {item.note}</span>
        )}
      </span>
      <span className="shrink-0 tabular-nums">
        {said}
        {formatRelative(item.resolvedAt!, now)}
      </span>
    </>
  );
}
