import type { CheckoutUser } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

import { useApi } from "@/api/context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useOpenThread } from "@/shell/thread-switcher";
import { useThreadsStore } from "@/stores/threads";

/** The open threads using the checkout at `path`, asked again as threads open and close. */
export function useCheckoutUsers(path: string | undefined): readonly CheckoutUser[] {
  const api = useApi();
  const openThreads = useThreadsStore((s) => Object.keys(s.byId).toSorted().join(","));
  const query = useQuery({
    queryKey: ["threads.usingCheckout", path, openThreads],
    queryFn: () => api.checkoutUsers(path!),
    enabled: path !== undefined && path !== "",
    retry: false,
  });
  return query.data?.threads ?? [];
}

/**
 * Warns that the chosen checkout already has an open thread: open that thread, use
 * a new worktree, or create here anyway where the server allows it. `refused` is a worktree the server
 * won't share, so there is no "create anyway".
 */
export function CheckoutInUseNotice({
  users,
  repo,
  refused,
  onUseNewWorktree,
  onUseAnotherBranch,
  onCreateAnyway,
}: {
  users: readonly CheckoutUser[];
  /** The folder is a git repository, so a worktree can isolate the new thread. */
  repo: boolean;
  refused: boolean;
  onUseNewWorktree?: () => void;
  onUseAnotherBranch?: () => void;
  onCreateAnyway?: () => void;
}) {
  const open = useOpenThread();
  const [first] = users;
  if (first === undefined) return null;
  const place = repo ? "checkout" : "folder";
  const title =
    users.length === 1
      ? `“${first.title}” is already open in this ${place}`
      : `${users.length} threads are already open in this ${place}`;

  return (
    <Alert data-testid="checkout-in-use">
      <TriangleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          {refused
            ? "Gram opens one thread per worktree."
            : `Two threads in one ${place} can clobber each other's changes.`}
          {repo && " A new worktree gives this thread its own checkout."}
          {users.some((user) => user.parked) && " Parked threads still use their checkout."}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {users.map((user) => (
            <Button
              key={user.threadId}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => open(user.threadId)}
            >
              Open “{user.title}”{user.parked ? " (parked)" : ""}
            </Button>
          ))}
          {repo && onUseNewWorktree && (
            <Button type="button" size="sm" variant="outline" onClick={onUseNewWorktree}>
              Use a new worktree instead
            </Button>
          )}
          {onUseAnotherBranch && (
            <Button type="button" size="sm" variant="outline" onClick={onUseAnotherBranch}>
              Use another branch name
            </Button>
          )}
          {!refused && onCreateAnyway && (
            <Button type="button" size="sm" variant="ghost" onClick={onCreateAnyway}>
              Create here anyway
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
