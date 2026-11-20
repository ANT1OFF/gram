import {
  VERIFY_FILE,
  type ThreadId,
  type VerifyDriverState,
  type VerifyEvidence,
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
import { AttachmentLightbox } from "@/thread/attachment-lightbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { spin } from "@/motion";

import { imageDataUrl } from "./files/image-preview";
import { PanelMessage } from "./panel-message";

// A worker's Proof: what Gram itself recorded of the repository's verify drivers on the worker's
// committed head, never what the worker wrote. Each driver's state, the command it runs, whether
// the repository requires it and whether it covers what the branch changed. A repository without
// a recipe has no Proof tool at all. Under a driver, what its run kept in its evidence folder:
// screenshots to open, videos and snapshots by name. They show what the driver chose to keep,
// never that it passed.

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

/** Names the server serves as pictures; a video or snapshot is named, not shown. */
const PICTURE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** One screenshot a driver kept, read when its row shows. */
function EvidencePicture({
  threadId,
  head,
  driver,
  item,
}: {
  threadId: ThreadId;
  head: string | undefined;
  driver: VerifyDriverState;
  item: VerifyEvidence;
}) {
  const api = useApi();
  // A run again on the same head writes the same names afresh: its start keys it apart.
  const run = [driver.name, driver.startedAt ?? 0, item.file, item.size] as const;
  const query = useQuery({
    queryKey: [...verifyStateQueryKey(threadId, head), "evidence", ...run],
    queryFn: () => api.verifyEvidence(threadId, driver.name, item.file),
    retry: false,
    staleTime: Infinity,
  });
  const src = imageDataUrl(query.data);
  const label = item.caption ?? item.file;
  return (
    <figure data-testid="proof-evidence" className="flex w-32 flex-col gap-1">
      {src === undefined ? (
        <div className="flex h-20 items-center justify-center rounded-md border border-border text-meta text-muted-foreground">
          {query.isPending
            ? "Loading…"
            : query.data?.tooLarge === true
              ? "Too large"
              : "Unavailable"}
        </div>
      ) : (
        <AttachmentLightbox
          src={src}
          name={item.file}
          description={label}
          thumbnailClassName="h-20 w-32 object-cover"
        />
      )}
      <figcaption className="truncate text-meta text-muted-foreground" title={label}>
        {label}
      </figcaption>
    </figure>
  );
}

/** What the driver's run kept to show: its screenshots, and the rest by name. */
function DriverEvidence({
  threadId,
  head,
  driver,
}: {
  threadId: ThreadId;
  head: string | undefined;
  driver: VerifyDriverState;
}) {
  const items = driver.evidence ?? [];
  const pictures = items.filter((item) => item.kind === "screenshot" && PICTURE.test(item.file));
  const named = items.filter((item) => !pictures.includes(item));
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {pictures.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pictures.map((item) => (
            <EvidencePicture
              key={item.file}
              threadId={threadId}
              head={head}
              driver={driver}
              item={item}
            />
          ))}
        </div>
      )}
      {named.map((item) => (
        <span
          key={item.file}
          data-testid="proof-evidence"
          className="truncate text-meta text-muted-foreground"
        >
          <span className="font-mono">{item.file}</span>
          {` · ${item.kind}`}
          {item.caption === undefined ? "" : ` · ${item.caption}`}
        </span>
      ))}
    </div>
  );
}

function DriverRow({
  driver,
  threadId,
  head,
}: {
  driver: VerifyDriverState;
  threadId: ThreadId;
  head: string | undefined;
}) {
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
        ref={driver.status === "running" ? spin : undefined}
        className={cn("mt-0.5 size-4 shrink-0", status.tone)}
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
        {driver.evidence !== undefined && (
          <DriverEvidence threadId={threadId} head={head} driver={driver} />
        )}
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
          <DriverRow key={driver.name} driver={driver} threadId={threadId} head={state.head} />
        ))}
      </ul>
    </div>
  );
}
