import type { ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudOff, CloudUpload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockTime } from "@/lib/time";
import { useThreadsStore } from "@/stores/threads";

import { sentHost, sentMark } from "./machine-mark";

/**
 * Above where the composer would be, for a worker sent to a server: it runs there under that
 * server's rules, this computer holds none of its files, and its orchestrator messages it; and
 * when this app can't hear from it, since when and why, with
 * the way to sign in again.
 */
export function SentNotice({ threadId }: { threadId: ThreadId }) {
  const sent = useThreadsStore((s) => s.byId[threadId]?.thread.sentTo);
  const navigate = useNavigate();
  if (sent === undefined) return null;
  const mark = sentMark(sent);
  const here = window.gram?.platform === "darwin" ? "This Mac" : "This computer";
  const host = sentHost(sent.origin);
  const unheard = sent.unheard !== undefined;
  const Glyph = unheard ? CloudOff : CloudUpload;
  return (
    <aside
      aria-label="Runs on a server"
      data-testid="sent-notice"
      data-state={mark.state ?? sent.state}
      className="flex w-full thread-column shrink-0 flex-col gap-2 px-6 py-2 text-reading"
    >
      <div className="flex items-start gap-3">
        <Glyph aria-hidden className="mt-0.5 size-icon-row shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1">
          Its orchestrator messages it, so there is no message box here.{" "}
          <span className="text-muted-foreground">{here} holds none of its files.</span>
        </p>
      </div>
      {unheard && (
        <div
          role="status"
          data-testid="sent-unheard"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7"
        >
          <p className="min-w-0 flex-1">
            {mark.state === "signed out" ? `Signed out of ${host}.` : `Not heard from ${host}.`}{" "}
            <span className="text-muted-foreground">
              It keeps running there. Its state here is as of{" "}
              {sent.heardAt === undefined ? "when it was sent" : formatClockTime(sent.heardAt)}, and
              its orchestrator isn't told when it finishes. {sent.unheard}
            </span>
          </p>
          {mark.state === "signed out" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/machines" })}
            >
              Sign in
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
