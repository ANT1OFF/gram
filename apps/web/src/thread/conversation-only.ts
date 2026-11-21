import type { GramUIMessage } from "@gram/contracts";

import { isToolPart, type MessagePart } from "./parts";
import { previewableFiles } from "./preview-files";
import { publishedArtifacts } from "./published-artifacts";
import { hasOwnImages } from "./tool-images";

/**
 * How the agent got there, which "Conversation only" leaves out: its tool calls (a subagent's card
 * among them), its reasoning, and the memory changes its tools made. A call's approval card needs
 * no row: without one it sits above the composer. The images a call returned stay, without it.
 */
export const isWork = (part: MessagePart): boolean =>
  isToolPart(part) || part.type === "reasoning" || part.type === "data-memory-write";

const AROUND: ReadonlySet<string> = new Set([
  "data-compaction",
  "data-session-restart",
  "data-turn-undo",
  "data-wait",
  "data-babysit-report",
  "data-dream-report",
  "data-handoff",
]);

/**
 * Whether "Conversation only" leaves a part of a reply out: work, or the bookkeeping around it.
 * What stays is what was said and what it asks or leaves: text, the task list, questions, cards,
 * pages, files, images and failures.
 */
export const leavesOut = (part: MessagePart): boolean => isWork(part) || AROUND.has(part.type);

const NOTICES: ReadonlySet<string> = new Set([
  "data-review-notice",
  "data-human-review-notice",
  "data-orchestration-digest",
  "data-idle-compact",
]);

/** Whether a person's message is one of Gram's notices, which the mode leaves out. */
export const isNotice = (message: GramUIMessage): boolean =>
  message.parts.some((part) => NOTICES.has(part.type));

const SILENT: ReadonlySet<string> = new Set([
  "step-start",
  "data-tool-image",
  "data-subagent-usage",
  "source-url",
  "source-document",
]);

/**
 * Whether a message leaves anything in a transcript that shows the conversation only: a notice or
 * a reply of nothing but work draws no row, though the pages and files that work published still do.
 */
export function showsInConversation(message: GramUIMessage): boolean {
  if (message.role !== "assistant") return !isNotice(message);
  const known = shown.get(message);
  if (known !== undefined) return known;
  const shows = draws(message);
  shown.set(message, shows);
  return shows;
}

const shown = new WeakMap<GramUIMessage, boolean>();

function draws(message: GramUIMessage): boolean {
  const said = message.parts.some((part) =>
    part.type === "text" ? part.text.trim() !== "" : !leavesOut(part) && !SILENT.has(part.type),
  );
  return (
    said ||
    showsImages(message) ||
    publishedArtifacts(message.parts).length > 0 ||
    previewableFiles(message.parts).length > 0
  );
}

const showsImages = (message: GramUIMessage): boolean =>
  message.parts.some(
    (part) => part.type === "data-tool-image" || (isToolPart(part) && hasOwnImages(part)),
  );

/** "Working 41s": the one line a running turn leaves where its calls would be. */
export const WORKING_LABEL = "Working";
