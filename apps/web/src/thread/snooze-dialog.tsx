import type { ThreadId } from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/use-now";

import { Dialog, DialogShell } from "./dialog-shell";
import { customSnooze, dateInputValue, snoozeTime } from "./snooze-model";

const FIELD =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-reading tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Snooze until a time of the user's choosing: a date and a 24-hour time, read on this machine's
 * clock. It says when the thread comes back before it is snoozed, and why a time can't be one.
 */
export function SnoozeDialog({ threadId, onClose }: { threadId: ThreadId; onClose: () => void }) {
  const api = useApi();
  const now = useNow(true, undefined, 30_000);
  const [date, setDate] = useState(() => dateInputValue(now + 86_400_000));
  const [time, setTime] = useState("09:00");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const parsed = customSnooze(date, time, now);

  const submit = async () => {
    if ("error" in parsed || pending) return;
    setPending(true);
    try {
      await api.snooze(threadId, parsed.at);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <DialogShell testId="snooze-dialog" title="Snooze until" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-muted-foreground">
            Date
            <input
              type="date"
              aria-label="Date"
              className={FIELD}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <label className="flex w-24 shrink-0 flex-col gap-1 text-meta text-muted-foreground">
            Time
            <input
              aria-label="Time, 24-hour"
              inputMode="numeric"
              placeholder="09:00"
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className={FIELD}
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
        </div>
        <p
          data-testid="snooze-dialog-when"
          role={"error" in parsed ? "alert" : undefined}
          className={
            "error" in parsed
              ? "text-reading text-destructive"
              : "text-reading text-muted-foreground"
          }
        >
          {"error" in parsed
            ? parsed.error
            : `Back ${snoozeTime(parsed.at, now)}, unread, or sooner if it needs you.`}
        </p>
        {error && (
          <p role="alert" className="text-reading text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Cancel
          </Dialog.Close>
          <Button type="submit" size="sm" disabled={"error" in parsed || pending}>
            Snooze
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
