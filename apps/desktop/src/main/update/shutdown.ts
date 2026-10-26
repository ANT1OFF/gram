import type { UpdateEssential, UpdateTeardown } from "@gram/contracts";
import type { ServerHost, StopOutcome, UpdateStopReport } from "../server-host.ts";

/** Why an essential stops the update, as the cancellation names it. */
const ESSENTIAL_FAILURE: Readonly<Record<UpdateEssential, string>> = {
  sessions: "Agent sessions did not stop and save their state in time.",
  agents:
    "An agent process (a Claude Code session or the Codex app-server) did not exit cleanly when stopped.",
  database: "The database could not be closed or sealed with nothing writing to it.",
};

/** A refused update stop, carrying what the receipt records of it. */
export class UpdateTeardownRefused extends Error {
  readonly teardown: Extract<UpdateTeardown, { path: "refused" }>;
  constructor(message: string, teardown: Extract<UpdateTeardown, { path: "refused" }>) {
    super(message);
    this.teardown = teardown;
  }
}

const refusal = (
  outcome: StopOutcome,
  report: UpdateStopReport | undefined,
): { readonly reason: string; readonly teardown: Extract<UpdateTeardown, { path: "refused" }> } => {
  if (report?.failed !== undefined)
    return {
      reason: ESSENTIAL_FAILURE[report.failed],
      teardown: { path: "refused", reason: report.failed },
    };
  switch (outcome) {
    case "survived":
      return {
        reason: "A process of the old server survived its kill.",
        teardown: { path: "refused", reason: "survivor" },
      };
    case "unverified":
      return {
        reason: "The old server's processes could not be confirmed gone after its kill.",
        teardown: { path: "refused", reason: "unverified" },
      };
    default:
      return {
        reason:
          outcome === "failed"
            ? "The server exited unsuccessfully."
            : outcome === "unconfirmed"
              ? "Completed server teardown was not confirmed."
              : outcome === "forced"
                ? "Server cleanup required forced termination."
                : "The server is still running after cleanup.",
        teardown: { path: "refused", reason: "teardown" },
      };
  }
};

/**
 * Refuses replacement unless the owned server proves its whole teardown completed (`clean`), or its
 * essentials attested and its whole remaining tree killed with nothing left (`forced`); `stopped`
 * hears which, for the log and the receipt.
 */
export async function stopForUpdate(
  server: Pick<ServerHost, "stop" | "updateStop">,
  stopped: (teardown: UpdateTeardown) => void = () => {},
): Promise<void> {
  const outcome = await server.stop("update");
  const report = server.updateStop();
  if (outcome === "exited") return stopped({ path: "clean" });
  if (outcome === "essentials")
    return stopped({
      path: "forced",
      killed: report?.killed?.under ?? 0,
      names: report?.killed?.names ?? [],
      waitingOn: report?.waitingOn ?? {},
    });
  const { reason, teardown } = refusal(outcome, report);
  throw new UpdateTeardownRefused(
    `Update cancelled before app replacement. ${reason} Gram remains on the running version. Check shutdown diagnostics before retrying.`,
    teardown,
  );
}
