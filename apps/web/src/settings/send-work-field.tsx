import { embeddingOn, type OrchestratorCharter } from "@gram/contracts";

import { useServerSettings } from "@/settings-sync/store";

import { Toggle } from "./fields";
import { withSendWork } from "./workspace-settings-model";

/**
 * Whether the orchestrator may send a worker to run on a server signed in to, as a thread of a
 * workspace there (`send_worker`). Off by default, and shown only in the desktop app with the
 * hosted features on, where a server can be signed in to at all.
 */
export function SendWorkField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const hosted = useServerSettings((s) => s.settings !== undefined && embeddingOn(s.settings));
  const desktop = typeof window !== "undefined" && window.gram?.hostedDevice?.work !== undefined;
  if (!hosted || !desktop) return null;
  const on = charter.sendWork === true;
  return (
    <div data-testid="send-work" data-value={on ? "on" : "off"}>
      <Toggle
        label="Send workers to servers"
        description="Let the orchestrator run a worker on a server you're signed in to, as a thread of a workspace there. You approve each."
        keywords={["hosted", "server", "remote", "send", "worker", "cloud"]}
        learnMore={
          <p>
            A sent worker runs under the server's rules and approvals, and keeps going while this
            computer sleeps. It works from the repository's remote, so it sees nothing uncommitted
            here, and its pull request is how the work comes back. Sign in under Settings →
            Machines.
          </p>
        }
        checked={on}
        disabled={disabled}
        onChange={(next) =>
          onChange(
            withSendWork(charter, next),
            next ? "Workers may be sent to a server" : "Workers stay on your machines",
          )
        }
      />
    </div>
  );
}
