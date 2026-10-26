import { KeyRound } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useApi } from "@/api/context";

/**
 * Covers the app once the server rejects this window's session, usually because Gram
 * restarted with a new launch token. Retrying can't help, so it replaces the reconnect banner.
 */
export function SessionExpiredScreen() {
  const { connection } = useApi();
  const state = useSyncExternalStore(connection.subscribe, connection.get, connection.get);
  if (state.status !== "expired") return null;

  return (
    <div
      role="alert"
      aria-labelledby="session-expired-title"
      data-testid="session-expired"
      className="fixed inset-0 z-100 flex items-center justify-center bg-background p-6"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <KeyRound aria-hidden className="size-6 text-muted-foreground" />
        <h1 id="session-expired-title" className="font-heading text-lg font-medium">
          Session expired
        </h1>
        <p className="text-sm text-muted-foreground">
          This window&apos;s launch token is no longer accepted, usually because Gram restarted.
          Reopen Gram to start a new session.
        </p>
      </div>
    </div>
  );
}
