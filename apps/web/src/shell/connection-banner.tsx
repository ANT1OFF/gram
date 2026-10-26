import { CloudCog, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";

/**
 * Shown while the server connection is down, counting down to the next reconnect attempt. When the
 * probe carries a server notice, its explanation is shown while retry remains available.
 */
export function ConnectionBanner() {
  const { connection } = useApi();
  const state = useSyncExternalStore(connection.subscribe, connection.get, connection.get);
  const reconnecting = state.status === "reconnecting";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!reconnecting) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [reconnecting]);

  if (!reconnecting) return null;
  const seconds = Math.max(0, Math.ceil(((state.retryAt ?? now) - now) / 1000));
  const notice = state.notice;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-banner"
      className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-sm"
    >
      {notice === undefined ? (
        <>
          <WifiOff aria-hidden className="size-4 text-warning" />
          <span>
            Reconnecting to the server…
            {seconds > 0 && <span className="text-muted-foreground"> retry in {seconds}s</span>}
          </span>
        </>
      ) : (
        <>
          <CloudCog aria-hidden className="size-4 text-warning" />
          <span>
            {notice.message}
            {notice.detail !== undefined && (
              <span className="text-muted-foreground"> {notice.detail}</span>
            )}
          </span>
        </>
      )}
      <Button size="xs" variant="ghost" className="ml-auto" onClick={() => connection.retryNow()}>
        <RefreshCw data-icon="inline-start" />
        Retry now
      </Button>
    </div>
  );
}
