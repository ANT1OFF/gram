import { pushActionOf, type GitState, type ThreadId } from "@gram/contracts";
import { ArrowUpFromLine, CloudUpload } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";

// Shared with the `wrap_up` tool, which offers a Push button only when this one would show.
export { pushActionOf };

/** "Publish branch", or "Push N commits" when origin's count is known. */
export function pushLabelOf(git: GitState | undefined): string | undefined {
  const action = pushActionOf(git);
  if (action === undefined) return undefined;
  if (action === "publish") return "Publish branch";
  const ahead = git?.aheadUpstream;
  return ahead === undefined ? "Push" : `Push ${ahead} commit${ahead === 1 ? "" : "s"}`;
}

const notify = (kind: "info" | "error", title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind, title, body });

/**
 * Publishing or pushing the thread's branch through `git.push`, with the server's refusals (behind,
 * diverged, no origin) shown as a toast. `action` is undefined when there's nothing to push.
 */
export function usePushBranch(threadId: ThreadId) {
  const api = useApi();
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const [pending, setPending] = useState(false);
  const action = pushActionOf(git);

  const push = async () => {
    setPending(true);
    try {
      const { branch, published } = await api.pushBranch(threadId);
      notify(
        "info",
        published ? `Published ${branch}` : `Pushed ${branch}`,
        published ? `origin/${branch} now tracks this branch.` : `origin/${branch} is up to date.`,
      );
    } catch (error) {
      notify("error", "Couldn't push", errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return {
    action,
    label: pushLabelOf(git),
    pendingLabel: action === "publish" ? "Publishing…" : "Pushing…",
    pending,
    push,
  };
}

/**
 * Publish or Push next to the branch's upstream state; hidden when there's nothing to push.
 */
export function PushButton({
  threadId,
  size = "xs",
  className,
}: {
  threadId: ThreadId;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { action, label, pendingLabel, pending, push } = usePushBranch(threadId);
  if (!action) return null;

  const Icon = action === "publish" ? CloudUpload : ArrowUpFromLine;
  const words = (pending ? pendingLabel : label) ?? "Push";
  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      data-testid="push-button"
      disabled={pending}
      className={className}
      onClick={() => void push()}
    >
      <Icon data-icon="inline-start" />
      {words}
    </Button>
  );
}
