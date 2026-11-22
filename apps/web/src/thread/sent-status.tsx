import type { SentTo, Thread } from "@gram/contracts";
import { CloudOff, CloudUpload } from "lucide-react";
import type { ReactNode } from "react";

import { agoText, formatClockTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";

import { sentHost } from "./machine-mark";

const HEADLINE: Readonly<Record<SentTo["state"], string>> = {
  running: "Running on a server",
  waiting: "Waiting on a person on the server",
  done: "Finished on the server",
  failed: "Failed on the server",
  stopped: "Stopped on the server",
};

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-meta text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * Where the transcript would be, for a worker sent to a server: its conversation is there, so this
 * says how it stands there as last heard, where it runs and under whose rules, when it was sent and
 * last heard from, its branch, and what it last said.
 */
export function SentStatus({ thread, sent }: { thread: Thread; sent: SentTo }) {
  const host = sentHost(sent.origin);
  const unheard = sent.unheard !== undefined;
  const Glyph = unheard ? CloudOff : CloudUpload;
  const reply = sent.reply?.trim() ?? "";
  const now = useNow(true, undefined, 30_000);
  return (
    <section
      data-testid="sent-status"
      data-state={sent.state}
      aria-labelledby={`${thread.id}-sent`}
      className="mx-auto flex w-full max-w-(--settings-column-wide) flex-col gap-5 p-6 text-reading"
    >
      <header className="flex items-start gap-3">
        <Glyph aria-hidden className="mt-1 size-icon-row shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${thread.id}-sent`} className="font-heading text-title">
            {unheard ? "Not heard from the server" : HEADLINE[sent.state]}
            {sent.working === true && sent.state === "running" && !unheard && (
              <span className="ms-2 text-meta font-normal text-muted-foreground">working now</span>
            )}
          </h2>
          <p>
            In {sent.workspace} on {host}, under {sent.server}&apos;s rules and approvals.{" "}
            <span className="text-muted-foreground">
              Its conversation is on that server, not this computer.
            </span>
          </p>
        </div>
      </header>
      <dl
        aria-label="Where it stands"
        className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 ps-7"
      >
        <Fact term="Sent">
          {agoText(sent.at, now, { long: true })} · {formatClockTime(sent.at)}
        </Fact>
        <Fact term="Last heard">
          {sent.heardAt === undefined
            ? "Not yet"
            : `${agoText(sent.heardAt, now, { long: true })} · ${formatClockTime(sent.heardAt)}`}
        </Fact>
        {sent.branch !== undefined && (
          <Fact term="Branch">
            <span className="font-mono text-meta">{sent.branch}</span>
          </Fact>
        )}
        <Fact term="Comes back as">Its pull request, which its orchestrator follows.</Fact>
      </dl>
      {reply !== "" && (
        <div data-testid="sent-status-reply" className="flex flex-col gap-1 ps-7">
          <span className="text-meta text-muted-foreground">
            {sent.state === "waiting" ? "It asks" : "Last said there"}
          </span>
          <p className="line-clamp-6 whitespace-pre-wrap">{reply}</p>
        </div>
      )}
    </section>
  );
}
