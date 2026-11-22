import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { messageParts } from "@/new-thread/path";
import { useHome } from "@/new-thread/use-folder";

/**
 * Why a form couldn't go on, under its fields: a quiet destructive note rather than a paragraph of
 * red. Folders the message names read as the repositories they hold (`owner/repo`) or with home as
 * `~`; each keeps its full path on hover.
 */
export function FormError({
  message,
  className,
  testId,
}: {
  message: string;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  return (
    <Alert
      variant="destructive"
      data-testid={testId}
      className={cn("border-destructive/30 bg-destructive/5 py-1.5 text-meta", className)}
    >
      <CircleAlert aria-hidden className="size-icon-row" />
      <AlertDescription className="text-meta break-words text-pretty">
        <FormErrorText message={message} />
      </AlertDescription>
    </Alert>
  );
}

/** A form error's words, its folders shortened as `FormError` shows them. */
export function FormErrorText({
  message,
  className,
}: {
  message: string;
  className?: string | undefined;
}) {
  const home = useHome();
  return (
    <span className={cn("break-words", className)}>
      {messageParts(message, home).map((part, i) =>
        "text" in part ? (
          <span key={i}>{part.text}</span>
        ) : (
          <span key={i} title={part.path} className="font-mono break-all">
            {part.label}
          </span>
        ),
      )}
    </span>
  );
}
