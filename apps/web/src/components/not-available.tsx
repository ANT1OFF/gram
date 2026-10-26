import { CircleSlash } from "lucide-react";

import { errorMessage, isNotImplemented } from "@/api/errors";
import { cn } from "@/lib/utils";

/** The empty state for a failed query: "not available yet" for unimplemented RPCs, else the error. */
export function QueryError({
  error,
  feature,
  className,
}: {
  error: unknown;
  /** What the user was trying to see, e.g. "The PR panel". */
  feature: string;
  className?: string;
}) {
  const unavailable = isNotImplemented(error);
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      <CircleSlash aria-hidden className="size-5" />
      <p>{unavailable ? `${feature} isn't available yet.` : `${feature} failed to load.`}</p>
      {!unavailable && <p className="font-mono text-xs">{errorMessage(error)}</p>}
    </div>
  );
}
