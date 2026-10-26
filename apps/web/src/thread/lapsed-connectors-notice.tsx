import type { ThreadId } from "@gram/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/motion";
import {
  listConnectorsSettling,
  SIGN_IN_POLL_MS,
  startConnectorSignIn,
  useThreadSignIns,
} from "@/panels/connector-sign-ins";
import { useLapsedDismissals } from "@/stores/lapsed-connectors";
import { useThreadsStore } from "@/stores/threads";

const NONE: ReadonlyArray<string> = [];

/**
 * Above the composer while a claude.ai connector that worked in this thread, or that Claude Code
 * remembers connecting, needs signing in again: its tools are gone until then. One line per
 * connector until it reconnects or is dismissed. Sign in is the Connectors panel's own sign-in,
 * and the connector list is read while it lasts, which is what reconnects the connector.
 */
export function LapsedConnectorsNotice({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const lapsed = useThreadsStore((s) => s.byId[threadId]?.lapsedConnectors) ?? NONE;
  const cold = useThreadsStore((s) => s.byId[threadId]?.status === "cold");
  const dismissed = useLapsedDismissals((s) => s.byThread[threadId]) ?? NONE;
  const signIns = useThreadSignIns(threadId);
  const shown = lapsed.filter((name) => !dismissed.includes(name));
  const signingIn = shown.some((name) => signIns[name] !== undefined);
  // The panel's query: whichever of the two is mounted reads the list while a sign-in lasts.
  useQuery({
    queryKey: ["connectors", threadId, cold],
    queryFn: async () => (await listConnectorsSettling(api, threadId)).list,
    enabled: signingIn,
    retry: false,
    refetchInterval: signingIn ? SIGN_IN_POLL_MS : false,
  });
  const signIn = useMutation({
    mutationFn: (name: string) => startConnectorSignIn(api, threadId, name),
  });
  if (shown.length === 0) return null;

  return (
    <aside
      aria-label="Connectors to sign in to again"
      data-testid="lapsed-connectors-notice"
      className="mx-auto flex w-full max-w-(--thread-max-width) shrink-0 flex-col gap-1 px-6 py-2 text-sm"
    >
      {shown.map((name) => {
        const pending = signIns[name];
        return (
          <div key={name} data-testid="lapsed-connector" className="flex items-center gap-3">
            {pending === undefined ? (
              <KeyRound aria-hidden className="size-4 shrink-0 text-warning-text" />
            ) : (
              <Spinner aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <p className="min-w-0 flex-1">
              {pending === undefined ? (
                <>
                  <span className="font-medium">{name}</span> needs signing in again.{" "}
                  <span className="text-muted-foreground">Its tools are gone until then.</span>
                </>
              ) : (
                <>
                  Finish signing in to <span className="font-medium">{name}</span> in your browser.
                </>
              )}
            </p>
            {pending === undefined ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={signIn.isPending}
                  onClick={() => signIn.mutate(name)}
                >
                  Sign in
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => useLapsedDismissals.getState().dismiss(threadId, name)}
                >
                  Not now
                </Button>
              </>
            ) : (
              pending.url !== undefined && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void openExternalUrl(api, pending.url!)}
                >
                  Open page again
                </Button>
              )
            )}
          </div>
        );
      })}
      {signIn.error && (
        <p role="alert" className="pl-7 text-xs text-destructive">
          {errorMessage(signIn.error)}
        </p>
      )}
    </aside>
  );
}
