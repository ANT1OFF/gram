import {
  VERIFY_FILE,
  type ThreadId,
  type VerifyDriverState,
  type VerifyRunStatus,
  type VerifyState,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { useApi } from "@/api/context";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { PanelMessage } from "./panel-message";

// A worker's Proof: what Gram itself recorded of the repository's verify drivers on the worker's
// committed head, never what the worker wrote. Each driver's state, the command it runs, whether
// the repository requires it and whether it covers what the branch changed. A repository without
// a recipe has no Proof tool at all.

/** How often the tab looks again while a driver is running. */
const RUNNING_POLL_MS = 5_000;

/** The query a worker's Proof reads, keyed by its head so a new commit reads afresh. */
export const verifyStateQueryKey = (threadId: ThreadId, head: string | undefined) =>
  ["verify", threadId, head ?? ""] as const;

export function useVerifyState(threadId: ThreadId, head: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: verifyStateQueryKey(threadId, head),
    queryFn: () => api.verifyState(threadId),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.drivers.some((driver) => driver.status === "running") === true
        ? RUNNING_POLL_MS
        : false,
  });
}

/** Glyph, tone and words per state, so a state never rests on colour alone. */
export const RUN_STATUS: Record<
  VerifyRunStatus,
  { icon: LucideIcon; tone: string; words: string }
> = {
  passed: { icon: CircleCheck, tone: "text-success", words: "Passed" },
  failed: { icon: CircleX, tone: "text-destructive", words: "Failed" },
  running: { icon: LoaderCircle, tone: "text-muted-foreground", words: "Running" },
  notRun: { icon: CircleDashed, tone: "text-muted-foreground", words: "Not run on this commit" },
};

/** The drivers that count: those that cover the change, or all of them where that isn't known. */
export const countedDrivers = (state: VerifyState): readonly VerifyDriverState[] =>
  state.drivers.filter((driver) => driver.coversChange !== false);

/** "3 of 4 passed" over the drivers that count, for the tool's count and the panel's chip. */
export const passedCount = (state: VerifyState): { passed: number; of: number } => {
  const counted = countedDrivers(state);
  return {
    passed: counted.filter((driver) => driver.status === "passed").length,
    of: counted.length,
  };
};

const seconds = (driver: VerifyDriverState): string | undefined => {
  if (driver.startedAt === undefined || driver.finishedAt === undefined) return undefined;
  const total = Math.max(0, Math.round((driver.finishedAt - driver.startedAt) / 1000));
  return total < 60
    ? `${total}s`
    : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
};

function DriverRow({ driver }: { driver: VerifyDriverState }) {
  const status = RUN_STATUS[driver.status];
  const Icon = status.icon;
  const outside = driver.coversChange === false;
  const took = seconds(driver);
  return (
    <li
      data-testid="proof-driver"
      data-status={driver.status}
      className={cn("flex items-start gap-3 px-3 py-2.5", outside && "text-muted-foreground")}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          status.tone,
          driver.status === "running" && "animate-spin",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2 text-reading">
          <span className="font-medium">{driver.name}</span>
          {driver.required === true && <Badge variant="outline">Required</Badge>}
        </div>
        <span className="truncate font-mono text-meta text-muted-foreground" title={driver.run}>
          {driver.run}
        </span>
        <span className="text-meta text-muted-foreground">
          {status.words}
          {driver.reason === undefined ? "" : `: ${driver.reason}`}
          {outside ? " · doesn't cover this change" : ""}
        </span>
      </div>
      {took !== undefined && (
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{took}</span>
      )}
    </li>
  );
}

/** A worker's Proof tool: Gram's record of each verify driver on its committed head. */
export function ProofPanel({ threadId, head }: { threadId: ThreadId; head: string | undefined }) {
  const query = useVerifyState(threadId, head, true);
  const state = query.data;
  if (state === undefined) {
    return (
      <PanelMessage loading={query.isPending}>
        {query.isPending ? "Reading the recipe…" : "Gram couldn't read this worker's checks."}
      </PanelMessage>
    );
  }
  if (state.recipe === "none") {
    return (
      <PanelMessage icon={ShieldCheck}>
        This repository has no {VERIFY_FILE}, so there are no checks of Gram's to show.
      </PanelMessage>
    );
  }
  if (state.recipe === "unreadable") {
    return <PanelMessage>{state.error ?? `${VERIFY_FILE} can't be read.`}</PanelMessage>;
  }
  const { passed, of } = passedCount(state);
  return (
    <div
      data-testid="proof-panel"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-reading font-medium">
            Recorded on head{" "}
            <span className="font-mono">{state.head?.slice(0, 7) ?? "unknown"}</span>
          </span>
          <span className="text-meta text-muted-foreground">
            Gram ran these itself. Nothing the worker wrote counts here.
          </span>
        </div>
        {of > 0 && (
          <Badge variant={passed === of ? "success" : "outline"}>
            {passed} of {of} passed
          </Badge>
        )}
      </div>
      {state.uncommitted !== undefined && (
        <p className="text-meta text-muted-foreground">
          {state.uncommitted} changed {state.uncommitted === 1 ? "file isn't" : "files aren't"}{" "}
          committed, and no run includes {state.uncommitted === 1 ? "it" : "them"}.
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {state.drivers.map((driver) => (
          <DriverRow key={driver.name} driver={driver} />
        ))}
      </ul>
    </div>
  );
}
