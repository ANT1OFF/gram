import {
  fileEditsOf,
  type ClaudeTools,
  type FileEdit,
  type SubagentUsageData,
  type GramUIMessage,
} from "@gram/contracts";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  type LucideIcon,
} from "lucide-react";

import { Spinner } from "@/motion/spinner";

export type MessagePart = GramUIMessage["parts"][number];
export type AnyToolPart = ToolUIPart<ClaudeTools> | DynamicToolUIPart;
export type ToolPartOf<Name extends keyof ClaudeTools> = Extract<
  AnyToolPart,
  { type: `tool-${Name}` }
>;

export function isToolPart(part: MessagePart): part is AnyToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

export const toolNameOf = (part: AnyToolPart) =>
  part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);

/** The files a tool call changed, read into the shared shape; `[]` for a call that changes none. */
export const partEdits = (part: AnyToolPart): FileEdit[] =>
  fileEditsOf(
    toolNameOf(part),
    part.input,
    part.state === "output-available" ? part.output : undefined,
  );

export type ToolPhase =
  | "pending"
  | "running"
  | "awaiting"
  | "done"
  | "error"
  | "denied"
  | "cancelled";

export function toolPhase(
  state: AnyToolPart["state"],
  errorText?: string,
  preliminary = false,
): ToolPhase {
  switch (state) {
    case "input-streaming":
      return "pending";
    case "input-available":
    case "approval-responded":
      return "running";
    case "approval-requested":
      return "awaiting";
    case "output-available":
      return preliminary ? "running" : "done";
    case "output-error":
      return errorText === "Cancelled" ? "cancelled" : "error";
    case "output-denied":
      return "denied";
  }
}

/** Icon shape + text per phase, so tool state never relies on colour alone. */
export const PHASE_DISPLAY: Record<ToolPhase, { label: string; icon: LucideIcon; tone: string }> = {
  pending: { label: "Preparing", icon: CircleDashed, tone: "text-muted-foreground" },
  running: { label: "Running", icon: Spinner, tone: "text-status-working" },
  awaiting: { label: "Needs approval", icon: Clock, tone: "text-status-needs" },
  done: { label: "Done", icon: CircleCheck, tone: "text-success" },
  error: { label: "Error", icon: CircleX, tone: "text-destructive" },
  cancelled: { label: "Cancelled", icon: CircleSlash, tone: "text-warning" },
  denied: { label: "Denied", icon: CircleSlash, tone: "text-warning" },
};

export interface SplitMessages {
  /** Messages rendered in the transcript. */
  top: GramUIMessage[];
  /** Subagent transcripts keyed by the Task tool call that spawned them. */
  children: ReadonlyMap<string, GramUIMessage[]>;
  /**
   * The newest snapshot for each subagent run, keyed by its tool call id. The server puts the part
   * on the run's own transcript once that lane has opened and on the reply before then, so the
   * whole history is swept rather than one message.
   */
  subagentUsage: ReadonlyMap<string, SubagentUsageData>;
}

export function splitSubagents(messages: readonly GramUIMessage[]): SplitMessages {
  const top: GramUIMessage[] = [];
  const children = new Map<string, GramUIMessage[]>();
  const subagentUsage = new Map<string, SubagentUsageData>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-subagent-usage") subagentUsage.set(part.data.toolCallId, part.data);
    }
    const parent = message.metadata?.parentToolUseId;
    if (parent === undefined) {
      top.push(message);
      continue;
    }
    const list = children.get(parent);
    if (list) list.push(message);
    else children.set(parent, [message]);
  }
  return { top, children, subagentUsage };
}

/** Whether two subagent maps hold the same transcripts, message for message. */
export const sameSubagents = (
  a: ReadonlyMap<string, readonly GramUIMessage[]>,
  b: ReadonlyMap<string, readonly GramUIMessage[]>,
): boolean =>
  a.size === b.size &&
  [...a].every(([toolCallId, list]) => {
    const other = b.get(toolCallId);
    return (
      other !== undefined &&
      other.length === list.length &&
      list.every((message, i) => other[i] === message)
    );
  });

/** Whether two usage maps hold the same snapshots. */
export const sameSubagentUsage = (
  a: ReadonlyMap<string, SubagentUsageData>,
  b: ReadonlyMap<string, SubagentUsageData>,
): boolean =>
  a.size === b.size && [...a].every(([toolCallId, usage]) => b.get(toolCallId) === usage);

export interface Chapter {
  id: string;
  /** Stable top-level anchor; resolve its current index when activated. */
  messageId: string;
  title: string;
  kind: "prompt" | "chapter";
  /** Index into `SplitMessages.top`. */
  index: number;
}

/** Whether two chapter lists would draw the same rail. */
export const sameChapters = (a: readonly Chapter[], b: readonly Chapter[]): boolean =>
  a.length === b.length &&
  a.every((chapter, i) => {
    const other = b[i]!;
    return (
      chapter.id === other.id &&
      chapter.messageId === other.messageId &&
      chapter.title === other.title &&
      chapter.kind === other.kind &&
      chapter.index === other.index
    );
  });

export function chaptersOf(top: readonly GramUIMessage[]): Chapter[] {
  return top.flatMap((message, index): Chapter[] => {
    if (message.metadata?.parentToolUseId !== undefined) return [];
    const explicit = message.parts.flatMap((part): Chapter[] =>
      part.type === "data-chapter"
        ? [
            {
              id: JSON.stringify([message.id, part.data.id]),
              messageId: message.id,
              title: part.data.title,
              kind: "chapter",
              index,
            },
          ]
        : [],
    );
    // An explicit chapter already names this anchor; don't add a second entry for the same row.
    if (explicit.length > 0 || message.role !== "user") return explicit;
    // These server notices render a card; their raw agent payload is behind a disclosure.
    if (
      message.parts.some(
        (part) =>
          part.type === "data-review-notice" ||
          part.type === "data-human-review-notice" ||
          part.type === "data-orchestration-digest",
      )
    )
      return [];
    // Only the user's visible text. Never inspect tool output, reasoning, metadata or data parts.
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .replace(/[\s\p{Cc}]+/gu, " ")
      .trim();
    const preview = Array.from(text.slice(0, 162)).slice(0, 80).join("");
    const title = preview
      ? preview + (preview.length < text.length ? "…" : "")
      : message.parts.some((part) => part.type === "file")
        ? "Attachment prompt"
        : message.parts.some((part) => part.type !== "text")
          ? "Non-text prompt"
          : "Empty prompt";
    return [
      { id: JSON.stringify([message.id]), messageId: message.id, title, kind: "prompt", index },
    ];
  });
}

export const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
