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

/** Parts that draw nothing wherever they are. A tool's image is drawn for its call (`showsImages`). */
const SILENT: ReadonlySet<string> = new Set([
  "step-start",
  "data-tool-image",
  "data-subagent-usage",
  "source-url",
  "source-document",
]);

/**
 * Whether a message leaves anything in a transcript that shows the conversation only: a reply of
 * nothing but work draws no row, though the pages and files that work published still do.
 */
export function showsInConversation(message: GramUIMessage): boolean {
  if (message.role !== "assistant") return true;
  const known = shown.get(message);
  if (known !== undefined) return known;
  const shows = draws(message);
  shown.set(message, shows);
  return shows;
}

/** Stored messages keep their identity, so each is read once. */
const shown = new WeakMap<GramUIMessage, boolean>();

function draws(message: GramUIMessage): boolean {
  const said = message.parts.some((part) =>
    part.type === "text" ? part.text.trim() !== "" : !isWork(part) && !SILENT.has(part.type),
  );
  return (
    said ||
    showsImages(message) ||
    publishedArtifacts(message.parts).length > 0 ||
    previewableFiles(message.parts).length > 0
  );
}

/**
 * Whether any of a message's tool calls returned an image: a screenshot or a picture it read stays
 * in the conversation, as a thumbnail where the call was, though the call itself is left out.
 */
const showsImages = (message: GramUIMessage): boolean =>
  message.parts.some(
    (part) => part.type === "data-tool-image" || (isToolPart(part) && hasOwnImages(part)),
  );

/** "Working 41s": the one line a running turn leaves where its calls would be. */
export const WORKING_LABEL = "Working";
