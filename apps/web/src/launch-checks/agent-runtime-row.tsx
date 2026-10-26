import type { AgentRuntime } from "@gram/contracts";
import {
  Ban,
  CircleArrowUp,
  CircleQuestionMark,
  CircleX,
  Clock3,
  Copy,
  Download,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { agentLabel } from "@/agents/agent-display";
import { errorMessage } from "@/api/errors";
import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyText } from "@/settings/copy-text";
import { DrawnCheck, Swap } from "@/motion";

import {
  installing,
  installProgress,
  newerNote,
  SOURCE_LABEL,
  verdictTone,
  type NewerNote,
} from "./agent-runtime-model";
import { CommandText } from "./command-text";
import { useRuntimeInstall } from "./use-agent-runtimes";

/** A ghost button that copies `command`, saying "Copied" until the pointer leaves. */
export function CopyCommandButton({
  command,
  label,
}: {
  command: string;
  label?: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Hint
      label={copied ? "Copied" : <CommandText text={`Copy \`${command}\``} />}
      render={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label ?? `Copy ${command}`}
          className="text-muted-foreground hover:text-foreground"
          onClick={() =>
            void copyText(command).then(
              () => setCopied(true),
              (e: unknown) => console.error("agent checks: copy command", e),
            )
          }
          onMouseLeave={() => setCopied(false)}
          onBlur={() => setCopied(false)}
        />
      }
    >
      <Swap swapKey={copied ? "copied" : "copy"}>
        {copied ? <DrawnCheck className="size-3 text-success" /> : <Copy aria-hidden />}
      </Swap>
    </Hint>
  );
}

/** The source beside a version: muted, and only when it isn't the user's own PATH install. */
export function SourceTag({ runtime }: { runtime: AgentRuntime }) {
  const resolved = runtime.resolved;
  if (resolved === undefined || resolved.source === "path") return null;
  return (
    <span
      data-testid="runtime-source"
      className="rounded-sm bg-muted px-1 text-[0.7rem] leading-4 text-muted-foreground"
    >
      {SOURCE_LABEL[resolved.source]}
    </span>
  );
}

const VERDICT_ICON = {
  warning: { Icon: TriangleAlert, tone: "text-warning" },
  error: { Icon: CircleX, tone: "text-destructive" },
  unknown: { Icon: CircleQuestionMark, tone: "text-muted-foreground" },
} as const;

/** An icon for a version that isn't plainly supported; its reason on hover. */
export function VerdictMark({ runtime }: { runtime: AgentRuntime }) {
  const tone = verdictTone(runtime);
  if (tone === "ok") return null;
  const { Icon, tone: colour } = VERDICT_ICON[tone];
  const reason = runtime.reason ?? "Compatibility unknown.";
  return (
    <Hint
      label={reason}
      render={
        <span
          tabIndex={0}
          data-testid="runtime-verdict"
          data-verdict={runtime.verdict}
          className={cn(
            "flex rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            colour,
          )}
        />
      }
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{reason}</span>
    </Hint>
  );
}

const NEWER_STYLE: Readonly<Record<NewerNote["kind"], { Icon: typeof Clock3; tone: string }>> = {
  update: { Icon: CircleArrowUp, tone: "text-info" },
  waiting: { Icon: Clock3, tone: "text-muted-foreground" },
  pending: { Icon: CircleQuestionMark, tone: "text-muted-foreground" },
  blocked: { Icon: Ban, tone: "text-muted-foreground" },
};

/** "0.159.4 available", "0.160.0 after 2 Oct, 17:12": the newest release, quietly. */
export function NewerMark({ runtime }: { runtime: AgentRuntime }) {
  const note = newerNote(runtime);
  if (note === undefined) return null;
  const { Icon, tone } = NEWER_STYLE[note.kind];
  return (
    <Hint
      label={note.detail}
      render={
        <span
          tabIndex={0}
          data-testid="runtime-newer"
          data-kind={note.kind}
          className={cn(
            "flex min-w-0 items-center gap-1 rounded-sm text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            tone,
          )}
        />
      }
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{note.summary}</span>
      <span className="sr-only">. {note.detail}</span>
    </Hint>
  );
}

/**
 * Update, where Gram's managed store serves the agent and has a newer qualified version past
 * its 24 hours; then the store's progress in its place.
 */
export function ManagedUpdate({ runtime }: { runtime: AgentRuntime }) {
  const api = useApi();
  const candidate = runtime.managed?.candidate;
  const { state } = useRuntimeInstall(runtime.agent, runtime.managed !== undefined);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const progress = installProgress(state);
  if (progress !== undefined)
    return (
      <span
        data-testid="runtime-progress"
        aria-live="polite"
        className={cn(
          "text-xs",
          state?.state === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {progress}
      </span>
    );
  if (candidate === undefined) return null;
  const busy = starting || installing(state);
  return (
    <Hint
      label={
        error ??
        `Download, verify and switch to ${candidate.version}, once ${agentLabel(runtime.agent)} is idle`
      }
      render={
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          data-testid="runtime-update"
          className={cn(error !== undefined && "text-destructive")}
          onClick={() => {
            setStarting(true);
            setError(undefined);
            api
              .installRuntime(runtime.agent, candidate.version)
              .catch((e: unknown) => setError(`Couldn't update: ${errorMessage(e)}`))
              .finally(() => setStarting(false));
          }}
        />
      }
    >
      <Download aria-hidden />
      {`Update to ${candidate.version}`}
    </Hint>
  );
}
