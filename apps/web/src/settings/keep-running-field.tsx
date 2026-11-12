import { keepRunningAfterQuitOn, type Settings, type SettingsPatch } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Toggle } from "./fields";

const KEPT_HOST = ["keptHost"] as const;

/** What the row says under itself: where the host runs now, and how to stop it. */
const statusLine = (status: {
  readonly on: boolean;
  readonly running: boolean;
  readonly sessions: number;
  readonly service?: string | undefined;
  readonly problem?: string | undefined;
}) => {
  if (status.problem !== undefined)
    return `Asked for, but it couldn't start this time: ${status.problem}`;
  if (status.running && !status.on) return "Still running until Gram next starts, which stops it.";
  if (status.running)
    return status.sessions === 0
      ? `Running as ${status.service ?? "a service"}, with no agent in it now.`
      : `Running as ${status.service ?? "a service"}, with ${status.sessions} agent ${
          status.sessions === 1 ? "session" : "sessions"
        } that go on if Gram quits.`;
  if (status.on) return "Starts when Gram next starts.";
  return undefined;
};

/**
 * "Keep agents running after Gram quits": this machine's host as a service of the user's, which
 * outlives the app. Off by default; it says where it runs while on, and stops it on request.
 */
export function KeepRunningField({
  settings,
  apply,
  onReset,
  error,
}: {
  settings: Settings;
  apply: (patch: SettingsPatch) => void;
  onReset?: (() => void) | undefined;
  error?: string | undefined;
}) {
  const api = useApi();
  const queries = useQueryClient();
  const status = useQuery({ queryKey: KEPT_HOST, queryFn: () => api.keptHost() });
  const [stopping, setStopping] = useState(false);
  /** Asked once: stopping it ends the agents in it, mid-turn too. */
  const [confirming, setConfirming] = useState(false);
  const [stopError, setStopError] = useState<string>();
  const on = keepRunningAfterQuitOn(settings);
  if (status.data !== undefined && !status.data.available) return null;
  const line = status.data === undefined ? undefined : statusLine({ ...status.data, on });
  const stop = () => {
    const sessions = status.data?.sessions ?? 0;
    if (sessions > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setStopping(true);
    setStopError(undefined);
    api
      .keptHostStop()
      .catch((cause: unknown) => setStopError(errorMessage(cause)))
      .finally(() => {
        setStopping(false);
        void queries.invalidateQueries({ queryKey: KEPT_HOST });
      });
  };
  return (
    <Toggle
      label="Run agents after quit"
      description="Agents keep working while Gram is closed. Applies from the next start."
      learnMore={
        <p>
          Gram runs this machine&rsquo;s host as a service of yours (a systemd user unit on Linux, a
          launchd agent on a Mac) instead of inside the app. An approval or question an agent asks
          while Gram is closed waits for you; Gram&rsquo;s own tools answer only while Gram is open.
          The service ends on its own once Gram has been closed for a while with nothing running.
          Codex sessions still stop when Gram quits.
        </p>
      }
      keywords={["quit", "background", "service", "systemd", "launchd", "keep running", "close"]}
      checked={on}
      onReset={onReset}
      error={error ?? stopError}
      detail={
        line === undefined ? undefined : (
          <div className="flex items-center gap-2 text-meta text-muted-foreground">
            <span data-testid="kept-host-status">{line}</span>
            {status.data?.running === true && (
              <Button
                size="xs"
                variant={confirming ? "destructive" : "outline"}
                disabled={stopping}
                onClick={stop}
              >
                {stopping
                  ? "Stopping…"
                  : confirming
                    ? `End ${status.data.sessions} agent ${status.data.sessions === 1 ? "session" : "sessions"}`
                    : "Stop now"}
              </Button>
            )}
          </div>
        )
      }
      onChange={(keep) => apply({ agents: { keepRunningAfterQuit: keep ? true : null } })}
    />
  );
}
