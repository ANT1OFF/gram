import type { GramUIMessage } from "@gram/contracts";

import { isToolPart, toolNameOf, type AnyToolPart } from "./parts";

export interface CopyOptions {
  /** Include thinking blocks as blockquotes; left out by default. */
  readonly reasoning?: boolean;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** The one detail that says what a tool call was about: its file, command, pattern or target. */
const toolSubject = (part: AnyToolPart): string | undefined => {
  const input = typeof part.input === "object" && part.input !== null ? part.input : {};
  const field = (key: string) => str((input as Record<string, unknown>)[key]);
  const subject =
    field("file_path") ??
    field("notebook_path") ??
    field("command") ??
    field("pattern") ??
    field("url") ??
    field("query") ??
    field("description") ??
    field("path");
  // One line: a multi-line command keeps its first line.
  return subject?.split("\n")[0]?.trim();
};

/** A tool call as one line, e.g. `[Read src/x.ts]`. */
const toolLine = (part: AnyToolPart): string => {
  const subject = toolSubject(part);
  return subject === undefined ? `[${toolNameOf(part)}]` : `[${toolNameOf(part)} ${subject}]`;
};

const fileName = (part: { readonly filename?: string | undefined; readonly url: string }) =>
  part.filename ??
  decodeURIComponent(part.url.replace(/^file:\/\//, ""))
    .split(/[\\/]/)
    .at(-1) ??
  part.url;

/**
 * A message as Markdown for the clipboard: text as written (code fences included), each tool call as
 * one line, attachments by file name. Thinking is left out unless asked for; other data parts
 * (chips, usage, chapters) aren't content.
 */
export function messageMarkdown(message: GramUIMessage, options: CopyOptions = {}): string {
  const blocks: string[] = [];
  let tools: string[] = [];
  const flushTools = () => {
    if (tools.length > 0) blocks.push(tools.join("\n"));
    tools = [];
  };
  for (const part of message.parts) {
    if (isToolPart(part)) {
      tools.push(toolLine(part));
      continue;
    }
    switch (part.type) {
      case "text":
        if (part.text.trim() !== "") {
          flushTools();
          blocks.push(part.text.trim());
        }
        break;
      case "reasoning":
        if (options.reasoning === true && part.text.trim() !== "") {
          flushTools();
          blocks.push(
            part.text
              .trim()
              .split("\n")
              .map((line) => (line === "" ? ">" : `> ${line}`))
              .join("\n"),
          );
        }
        break;
      case "file":
        tools.push(`[Attached ${fileName(part)}]`);
        break;
      default:
        break;
    }
  }
  flushTools();
  return blocks.join("\n\n");
}

/** A turn as Markdown: the prompt, then each reply, under their own headings. */
export function turnMarkdown(
  messages: readonly GramUIMessage[],
  options: CopyOptions = {},
): string {
  const sections: string[] = [];
  for (const message of messages) {
    const body = messageMarkdown(message, options);
    if (body === "") continue;
    const heading = message.role === "user" ? "**You**" : "**Assistant**";
    sections.push(`${heading}\n\n${body}`);
  }
  return sections.join("\n\n");
}

/**
 * The top-level messages of the turn that ends with `lastId`: back to the user prompt that started
 * it. Subagent messages belong to their Task card, not the turn's text.
 */
export function turnMessages(messages: readonly GramUIMessage[], lastId: string): GramUIMessage[] {
  const top = messages.filter((m) => m.metadata?.parentToolUseId === undefined);
  const end = top.findIndex((m) => m.id === lastId);
  if (end === -1) return [];
  let start = end;
  while (start > 0 && top[start]!.role !== "user") start--;
  return top.slice(top[start]!.role === "user" ? start : end, end + 1);
}
