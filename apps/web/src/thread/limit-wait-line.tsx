import type { LimitWait, Thread } from "@gram/contracts";
import { CircleCheck, Hourglass } from "lucide-react";
import { useEffect, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { formatClockTime } from "@/lib/time";
import { resetText } from "@/usage/limit-format";

/**
 * "Limit reached · resumes 12:50", "Rate limited · retries 12:31", "Limit reset · on hold", or
 * "Limit cleared · resumes 11:04" once fresh data showed the limit no longer applies. A resume on
 * another day names it, "resumes Sat 21:00", as the usage meter names its resets.
 */
export const limitWaitLabel = (
  wait: Pick<LimitWait, "kind" | "resumeAt" | "cancelled" | "cleared">,
  now: number,
  intl?: { readonly locale?: string; readonly timeZone?: string },
): string => {
  if (wait.cancelled === true) return "Limit reached · auto-resume off";
  if (now >= wait.resumeAt)
    return wait.kind === "limit" ? "Limit reset · on hold" : "Rate limited · on hold";
  const at = resetText(wait.resumeAt, now, intl);
  if (wait.cleared !== undefined) return `Limit cleared · resumes ${at}`;
  return wait.kind === "limit" ? `Limit reached · resumes ${at}` : `Rate limited · retries ${at}`;
};

/** "Limit cleared · resumed 11:04": a wait that ended early, as fresh data said it could. */
export const limitClearedLabel = (
  cleared: NonNullable<Thread["limitCleared"]>,
  intl?: { readonly locale?: string; readonly timeZone?: string },
): string => `Limit cleared · resumed ${formatClockTime(cleared.at, intl)}`;

/**
 * The one quiet line a thread waiting out a provider limit shows instead of an error: when it
 * resumes on its own, and the user's way to resume now or stop waiting. Once a wait ended early, as
 * the limit no longer applied, the line says so until the user writes or another wait begins.
 */
export function LimitWaitLine({
  thread,
}: {
  thread: Pick<Thread, "id" | "limitWait" | "limitCleared">;
}) {
  const api = useApi();
  const wait = thread.limitWait;
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  // Only to turn "resumes 12:50" into "on hold" once the time passes with the thread still held.
  useEffect(() => {
    if (wait === undefined) return;
    const left = wait.resumeAt - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(left + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [wait]);
  if (wait === undefined) {
    if (thread.limitCleared === undefined) return null;
    return (
      <div
        data-testid="limit-cleared"
        className="mx-auto my-2 flex w-full max-w-3xl items-center gap-2 px-1 text-xs text-muted-foreground"
      >
        <CircleCheck aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{limitClearedLabel(thread.limitCleared)}</span>
      </div>
    );
  }
  const act = (run: () => Promise<void>) => {
    setPending(true);
    run()
      .catch((e: unknown) => console.error("limit wait", e))
      .finally(() => setPending(false));
  };
  return (
    <div
      data-testid="limit-wait"
      data-kind={wait.kind}
      data-cleared={wait.cleared === undefined ? undefined : true}
      className="mx-auto my-2 flex w-full max-w-3xl items-center gap-2 px-1 text-xs text-muted-foreground"
    >
      <Hourglass aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{limitWaitLabel(wait, now)}</span>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending}
        onClick={() => act(() => api.resumeLimitWait(thread.id))}
      >
        Resume now
      </Button>
      {wait.cancelled !== true && (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => act(() => api.cancelLimitWait(thread.id))}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
