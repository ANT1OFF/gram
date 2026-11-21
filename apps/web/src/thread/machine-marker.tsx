import type { HostId, SentTo, ThreadId } from "@gram/contracts";
import { CloudOff, CloudUpload, Server, ServerOff } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useMachines } from "@/stores/machines";
import { useThreadsStore } from "@/stores/threads";

import { machineMark, sentMark, threadHost, type MachineMark } from "./machine-mark";

/**
 * The mark of the machine `hostId`, following the machines as the server sends them; for a worker
 * sent to a server (`sent`), that server's workspace instead.
 */
export function useMachineMark(
  hostId: HostId | undefined,
  sent?: SentTo | undefined,
): MachineMark | undefined {
  const machines = useMachines((s) => s.machines);
  if (sent !== undefined) return sentMark(sent);
  return hostId === undefined ? undefined : machineMark(hostId, machines);
}

/** Where a worker sent to a server runs, by the thread's id; `undefined` for any other thread. */
export const useThreadSent = (threadId: ThreadId | undefined): SentTo | undefined =>
  useThreadsStore((s) => (threadId === undefined ? undefined : s.byId[threadId]?.thread.sentTo));

/**
 * A hosted server's mark in a glyph's place: the image it gave (`MachineState.hosted`), or the first
 * letter of its name on a tile the size of a glyph.
 */
export function HostedMark({
  hosted,
  className,
}: {
  hosted: NonNullable<MachineMark["hosted"]>;
  className?: string | undefined;
}) {
  if (hosted.logo?.startsWith("data:image/") === true)
    return (
      <img
        data-testid="hosted-mark"
        data-mark="logo"
        src={hosted.logo}
        alt=""
        aria-hidden
        draggable={false}
        className={cn("size-icon-chip shrink-0 rounded-2xs object-contain", className)}
      />
    );
  return (
    <span
      data-testid="hosted-mark"
      data-mark="letter"
      aria-hidden
      className={cn(
        "flex size-icon-chip shrink-0 items-center justify-center rounded-2xs bg-muted text-caption leading-none font-semibold text-foreground",
        className,
      )}
    >
      {[...hosted.name.trim()][0]?.toLocaleUpperCase() ?? "?"}
    </span>
  );
}

/**
 * The glyph of a mark: a machine, a server's cloud for a sent worker, or the hosted server's own
 * mark for a worker's machine it gave; struck when out of reach.
 */
export function MarkGlyph({ mark, className }: { mark: MachineMark; className?: string }) {
  if (mark.hosted !== undefined && mark.state === undefined)
    return <HostedMark hosted={mark.hosted} className={className} />;
  if (mark.sent === true)
    return mark.state === "signed out" || mark.state === "not heard" ? (
      <CloudOff aria-hidden className={className} />
    ) : (
      <CloudUpload aria-hidden className={className} />
    );
  return mark.state === undefined ? (
    <Server aria-hidden className={className} />
  ) : (
    <ServerOff aria-hidden className={className} />
  );
}

/** The other machine a thread runs on, by the thread's id; `undefined` on this machine. */
export const useThreadHost = (threadId: ThreadId | undefined): HostId | undefined =>
  useThreadsStore((s) =>
    threadId === undefined ? undefined : threadHost(s.byId[threadId]?.thread),
  );

/**
 * Where a thread runs when that isn't this machine, wherever the thread is listed: the machine's
 * glyph and name in muted words, and nothing at all for a thread on this machine. A machine nothing
 * reaches takes the struck glyph and says so ("offline", "needs update") in the text colour, never
 * a status colour: a turn it failed already has its red dot.
 *
 * `show="glyph"` is the glyph alone, for a row whose edge already has words of its own: the struck
 * glyph still says offline, and the name is on the hover. `hover` is how it says the rest: its own
 * instant hint, a native title inside a row that has one, or nothing where the row's hover (a
 * worker's card, a row's title) already says it.
 */
export function MachineMarker({
  hostId,
  sent,
  show = "name",
  hover = "hint",
  side = "top",
  delay,
  testId = "machine-marker",
  className,
}: {
  hostId: HostId | undefined;
  /** A worker sent to a server: marked by the workspace there, not a machine. */
  sent?: SentTo | undefined;
  show?: "name" | "glyph";
  hover?: "hint" | "title" | "none";
  side?: "top" | "right" | "bottom" | "left";
  /** Ms before its hint shows, where it is met in passing (the Board's cells); none by default. */
  delay?: number | undefined;
  testId?: string;
  className?: string | undefined;
}) {
  const mark = useMachineMark(hostId, sent);
  if (mark === undefined) return null;
  const words = show === "name";
  const body = (
    <>
      <MarkGlyph mark={mark} className="size-icon-chip shrink-0" />
      {words && mark.hosted === undefined && mark.name !== undefined && (
        <span className="min-w-0 truncate">{mark.name}</span>
      )}
      {words && mark.state !== undefined && <span className="shrink-0">{mark.state}</span>}
    </>
  );
  const props = {
    "data-testid": testId,
    "data-machine-state": mark.state ?? "online",
    "data-sent": mark.sent,
    role: "img" as const,
    "aria-label": `Runs ${mark.words}`,
    className: cn(
      "flex h-lh min-w-0 items-center gap-1 text-meta whitespace-nowrap",
      words ? "shrink" : "shrink-0",
      mark.state === undefined
        ? "text-muted-foreground"
        : mark.state === "asks you"
          ? "text-status-needs"
          : "text-foreground",
      className,
    ),
  };
  if (hover === "hint")
    return (
      <Hint label={mark.hint} side={side} delay={delay} render={<span {...props} />}>
        {body}
      </Hint>
    );
  return (
    <span {...props} title={hover === "title" ? mark.hint : undefined}>
      {body}
    </span>
  );
}

/** A thread's marker by its id, for a list that has the id but not the thread. */
export function ThreadMachineMarker({
  threadId,
  ...rest
}: { threadId: ThreadId } & Omit<Parameters<typeof MachineMarker>[0], "hostId">) {
  return (
    <MachineMarker hostId={useThreadHost(threadId)} sent={useThreadSent(threadId)} {...rest} />
  );
}
