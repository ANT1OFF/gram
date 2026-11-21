import { CircleAlert } from "lucide-react";

import { FormErrorText } from "@/components/form-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * New workspace's Start saved the workspace and then couldn't open its orchestrator: what is done,
 * why the rest failed in the server's words, and the two ways on, so the person neither makes it
 * twice nor thinks nothing happened.
 */
export function SavedNotOpened({ name, reason }: { name: string; reason: string }) {
  return (
    <Alert variant="warning" data-testid="new-workspace-saved-not-opened">
      <CircleAlert aria-hidden />
      <AlertTitle>{name} is saved, but its orchestrator didn't open</AlertTitle>
      <AlertDescription className="flex flex-col gap-1 text-meta">
        <FormErrorText message={reason} className="text-foreground" />
        <span>
          Open orchestrator tries again, or leave it saved and open it later from your list.
        </span>
      </AlertDescription>
    </Alert>
  );
}
