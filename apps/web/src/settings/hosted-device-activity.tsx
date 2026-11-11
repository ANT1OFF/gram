import {
  type DeviceRefusalReason,
  displayCommand,
  type HostedDeviceActivity,
  type HostedDeviceView,
} from "@gram/contracts";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatStamp } from "@/lib/time";

import { SETTINGS_CARD } from "./settings-group";

type Bridge = NonNullable<NonNullable<Window["gram"]>["hostedDevice"]>;
type Entry = HostedDeviceActivity["entries"][number];

/**
 * Words from a server or a command on one line, with codes nobody could see drawn as their codes:
 * a thread title or a command can't reorder the row or pass for another.
 */
export const oneLine = (text: string): string =>
  displayCommand(text)
    .pieces.map((piece) => (piece.kind === "newline" ? " ⏎ " : piece.text))
    .join("");

/** Why Gram itself refused, after "Gram refused". */
const GRAM_REFUSED: Record<
  Exclude<DeviceRefusalReason, "not-allowed-by-person" | "not-answered">,
  string
> = {
  "no-grant": "you hadn't written to this thread from here lately",
  away: "you were away, or lending had stopped",
  "outside-folders": "outside the lent folders",
  "credential-path": "holds credentials",
  "not-a-file": "not a regular file",
  "too-many-requests": "too many requests",
  paused: "lending was paused",
  "read-only": "reads only",
  "too-large": "too large",
  "not-for-this-person": "asked for someone else",
  "changed-request": "a repeated request had changed",
};

const outcome = (entry: Entry): string | undefined => {
  if (entry.timedOut === true) return "ran out of time";
  if (entry.signal !== undefined) return `stopped by ${entry.signal}`;
  if (entry.exitCode !== undefined) return `exit ${entry.exitCode}`;
  return undefined;
};

function Answer({ entry }: { entry: Entry }) {
  const { answer } = entry;
  if (answer === "allowed") {
    const after = outcome(entry);
    return (
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant="outline">You allowed it</Badge>
        {after !== undefined && <span className="text-muted-foreground">{after}</span>}
      </span>
    );
  }
  if (answer === "withdrawn") return <Badge variant="secondary">Taken back by the server</Badge>;
  if (answer === "not-allowed-by-person") return <Badge variant="destructive">You refused</Badge>;
  if (answer === "not-answered") return <Badge variant="secondary">Not answered</Badge>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant="destructive">Gram refused</Badge>
      <span className="text-muted-foreground">{GRAM_REFUSED[answer]}</span>
    </span>
  );
}

const askedFor = (entry: Entry): string =>
  entry.kind === "exec" ? oneLine(entry.what) : `${entry.kind} ${oneLine(entry.what)}`;

/** The workspace's name as the server lists it now, else its id. */
const workspaceName = (view: HostedDeviceView, entry: Entry): string =>
  view.servers
    .find((server) => server.origin === entry.origin)
    ?.workspaces.find((workspace) => workspace.id === entry.workspace)?.name ?? entry.workspace;

/**
 * Activity on this computer: what hosted workspaces asked of it and how each was answered, from
 * the record the app keeps here. Read when opened, and again while open whenever the device says
 * it changed.
 */
export function HostedDeviceActivityList({
  bridge,
  view,
  machine,
}: {
  bridge: Bridge;
  view: HostedDeviceView;
  machine: string;
}) {
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<HostedDeviceActivity | null>();
  const read = useCallback(() => {
    void bridge.activity().then(setActivity, () => setActivity(null));
  }, [bridge]);
  useEffect(() => {
    if (!open) return undefined;
    read();
    return bridge.onChange(read);
  }, [bridge, open, read]);

  return (
    <div className={SETTINGS_CARD} data-testid="hosted-activity">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">Activity on {machine}</span>
          <span className="text-meta text-muted-foreground">
            What was asked here and how it was answered. Kept on {machine} only; what commands
            printed isn't kept.
          </span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && <ActivityBody activity={activity} view={view} machine={machine} />}
    </div>
  );
}

function ActivityBody({
  activity,
  view,
  machine,
}: {
  activity: HostedDeviceActivity | null | undefined;
  view: HostedDeviceView;
  machine: string;
}) {
  if (activity === undefined) return <p className="text-meta text-muted-foreground">Reading…</p>;
  if (activity === null)
    return (
      <p role="alert" className="text-meta text-destructive">
        Gram couldn't read the record.
      </p>
    );
  if (!activity.kept)
    return (
      <p className="text-meta text-muted-foreground">
        No record is kept on {machine} while lending isn't available.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {!activity.intact && (
        <p role="alert" className="text-meta text-destructive" data-testid="activity-edited">
          The record was changed outside Gram. Only what came before the change is listed.
        </p>
      )}
      {activity.setAside && (
        <p className="text-meta text-muted-foreground">
          When Gram started, the record had been changed outside it. That copy was set aside beside
          this one.
        </p>
      )}
      {activity.entries.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          Nothing has been asked of {machine}. Once you lend it, each request and its answer is
          listed here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-meta">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pe-3 font-normal">When</th>
                <th className="py-1 pe-3 font-normal">Workspace · thread</th>
                <th className="py-1 pe-3 font-normal">Folder</th>
                <th className="py-1 pe-3 font-normal">Asked for</th>
                <th className="py-1 font-normal">Answer</th>
              </tr>
            </thead>
            <tbody>
              {activity.entries.map((entry, index) => (
                <tr
                  // Lines have no id of their own; their order is fixed, newest first.
                  key={`${entry.time}-${index}`}
                  className="border-t border-border align-top"
                  data-testid="activity-row"
                >
                  <td className="py-1 pe-3 whitespace-nowrap tabular-nums">
                    {formatStamp(entry.time)}
                  </td>
                  <td className="max-w-56 truncate py-1 pe-3">
                    {oneLine(workspaceName(view, entry))}
                    <span className="text-muted-foreground"> · {oneLine(entry.threadTitle)}</span>
                  </td>
                  <td className="max-w-48 truncate py-1 pe-3 font-mono">{oneLine(entry.folder)}</td>
                  <td className="max-w-72 py-1 pe-3 font-mono break-all">{askedFor(entry)}</td>
                  <td className="py-1">
                    <Answer entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {activity.more && (
        <p className="text-meta text-muted-foreground">Older requests are kept but not listed.</p>
      )}
    </div>
  );
}
