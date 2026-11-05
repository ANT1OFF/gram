import type { Autonomy, PermissionMode } from "@gram/contracts";
import { Shield } from "lucide-react";
import { createElement } from "react";

import { MODE_ICONS, MODE_OPTIONS } from "@/composer/options";
import { cn } from "@/lib/utils";
import { AUTONOMY_ICON } from "@/orchestration/autonomy-chip";
import { presentAutonomy } from "@/settings/workspace-settings-model";
import { modeWarning } from "@/thread/mode-warning";
import { known } from "@/thread/orchestration-model";

/** What a workspace's workers do unasked at each level, said of several of them. */
const WORKERS_MAY: Readonly<Record<Autonomy, string>> = {
  supervised: "Workers ask you before a push, a pull request or a merge.",
  publish: "Workers push and open pull requests on their own; merges wait for you.",
  full: "Workers push, open and merge pull requests without asking you.",
};

/** The same, said of the one worker a direct start makes. */
const WORKER_MAY: Readonly<Record<Autonomy, string>> = {
  supervised: "It asks you before a push, a pull request or a merge.",
  publish: "It pushes and opens a pull request on its own; merging waits for you.",
  full: "It pushes, opens and merges its pull request without asking you.",
};

/**
 * Who acts on a task and what still needs the user, in one plain sentence pair: who directs the
 * work (the orchestrator, or the user while a direct worker is held), then what the workspace's
 * autonomy lets it publish unasked. A level this build doesn't know says so rather than guessing.
 */
export function taskAuthority({
  way,
  autonomy,
  hold,
}: {
  way: "plan" | "direct";
  autonomy: string;
  hold: boolean;
}): string {
  const who =
    way === "plan"
      ? "The orchestrator plans it and briefs workers."
      : hold
        ? "You direct this worker until you hand it back."
        : "The orchestrator directs this worker.";
  const may =
    known(way === "plan" ? WORKERS_MAY : WORKER_MAY, autonomy as Autonomy) ??
    presentAutonomy(autonomy).description;
  return `${who} ${may}`;
}

/**
 * The New form's one line beside Start on who acts and what needs approval: the workspace's
 * autonomy level by name (amber at Full, as everywhere it is named), then `taskAuthority`. The
 * controls that change either sit under Control and approvals; this line is never folded away.
 */
export function TaskAuthorityLine({
  way,
  autonomy,
  hold,
}: {
  way: "plan" | "direct";
  autonomy: string;
  hold: boolean;
}) {
  const level = presentAutonomy(autonomy);
  const icon = known(AUTONOMY_ICON, autonomy as Autonomy) ?? Shield;
  return (
    <p
      data-testid="task-authority"
      data-autonomy={autonomy}
      data-hold={hold ? "true" : undefined}
      className="flex min-w-0 items-start gap-1.5 text-meta text-muted-foreground"
    >
      {createElement(icon, {
        "aria-hidden": true,
        className: cn("mt-px size-3.5 shrink-0", level.warn && "text-warning"),
      })}
      <span className="min-w-0">
        <span className={cn("font-medium", level.warn ? "text-warning" : "text-foreground")}>
          {level.label} autonomy
        </span>
        {" · "}
        {taskAuthority({ way, autonomy, hold })}
      </span>
    </p>
  );
}

/** A single agent chat's line: the user directs one agent, and its mode says what it asks first. */
export function chatAuthority(mode: PermissionMode): { label: string; line: string } {
  const option = MODE_OPTIONS.find((each) => each.value === mode);
  return {
    label: option?.label ?? mode,
    line: `You direct one agent in this folder, with no orchestrator. ${option?.description ?? ""}`.trim(),
  };
}

/** The chat form's counterpart of `TaskAuthorityLine`: the mode by name, amber when it never asks. */
export function ChatAuthorityLine({ mode }: { mode: PermissionMode }) {
  const { label, line } = chatAuthority(mode);
  const warned = modeWarning(mode) !== undefined;
  return (
    <p
      data-testid="chat-authority"
      data-mode={mode}
      className="flex min-w-0 items-start gap-1.5 text-meta text-muted-foreground"
    >
      {createElement(MODE_ICONS[mode], {
        "aria-hidden": true,
        className: cn("mt-px size-3.5 shrink-0", warned && "text-warning"),
      })}
      <span className="min-w-0">
        <span className={cn("font-medium", warned ? "text-warning" : "text-foreground")}>
          {label}
        </span>
        {" · "}
        {line}
      </span>
    </p>
  );
}
