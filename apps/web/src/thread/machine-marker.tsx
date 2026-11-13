import type { HostId, ThreadId } from "@gram/contracts";
import { Server, ServerOff } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useMachines } from "@/stores/machines";
import { useThreadsStore } from "@/stores/threads";

import { machineMark, threadHost, type MachineMark } from "./machine-mark";

/** The mark of the machine `hostId`, following the machines as the server sends them. */
export function useMachineMark(hostId: HostId | undefined): MachineMark | undefined {
  const machines = useMachines((s) => s.machines);
  return hostId === undefined ? undefined : machineMark(hostId, machines);
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
  show = "name",
  hover = "hint",
  side = "top",
  delay,
  testId = "machine-marker",
  className,
}: {
  hostId: HostId | undefined;
  show?: "name" | "glyph";
  hover?: "hint" | "title" | "none";
  side?: "top" | "right" | "bottom" | "left";
  /** Ms before its hint shows, where it is met in passing (the Board's cells); none by default. */
  delay?: number | undefined;
  testId?: string;
  className?: string | undefined;
}) {
  const mark = useMachineMark(hostId);
  if (mark === undefined) return null;
  const Glyph = mark.state === undefined ? Server : ServerOff;
  const words = show === "name";
  const body = (
    <>
      <Glyph aria-hidden className="size-icon-chip shrink-0" />
      {words && mark.name !== undefined && <span className="min-w-0 truncate">{mark.name}</span>}
      {words && mark.state !== undefined && <span className="shrink-0">{mark.state}</span>}
    </>
  );
  const props = {
    "data-testid": testId,
    "data-machine-state": mark.state ?? "online",
    role: "img" as const,
    "aria-label": `Runs ${mark.words}`,
    className: cn(
      "flex h-lh min-w-0 items-center gap-1 text-meta whitespace-nowrap",
      // The glyph alone never gives way; with its name it shrinks, and the name is cut.
      words ? "shrink" : "shrink-0",
      mark.state === undefined ? "text-muted-foreground" : "text-foreground",
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
  return <MachineMarker hostId={useThreadHost(threadId)} {...rest} />;
}
