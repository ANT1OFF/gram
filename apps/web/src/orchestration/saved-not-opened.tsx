import { CircleAlert } from "lucide-react";

import { FOLD, FoldSummary } from "@/components/fold-summary";
import { FormErrorText } from "@/components/form-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * New workspace's Start saved the workspace and then couldn't open its orchestrator: what is done
 * and the two ways on, so the person neither makes it twice nor thinks nothing happened. The
 * server's own words are under Details.
 */
export function SavedNotOpened({ name, reason }: { name: string; reason: string }) {
  return (
    <Alert variant="warning" data-testid="new-workspace-saved-not-opened">
      <CircleAlert aria-hidden />
      <AlertTitle>{name} is saved, but its orchestrator didn't open</AlertTitle>
      <AlertDescription className="flex flex-col gap-1 text-meta">
        <span>
          Open orchestrator tries again, or leave it saved and open it later from your list.
        </span>
        <details className={FOLD}>
          <FoldSummary>Details</FoldSummary>
          <FormErrorText message={reason} className="mt-1 block text-foreground" />
        </details>
      </AlertDescription>
    </Alert>
  );
}
