import type { GramUIMessage } from "@gram/contracts";

import { redactText } from "../logging/redact.ts";

const field = (part: object, key: string): unknown => Reflect.get(part, key);

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The input field that says what a tool call was about: a command, a path, a pattern. */
const TARGET_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description"];

/**
 * A tool call as one line, `Tool: Bash `pnpm test` → failed`: its name, target and outcome, never
 * its output, which is where a whole file or log would ride along.
 */
const toolLine = (part: object, type: string): string => {
  const named = field(part, "toolName");
  const name = typeof named === "string" ? named : type.slice("tool-".length);
  const input = field(part, "input");
  const target =
    typeof input === "object" && input !== null
      ? TARGET_KEYS.map((key) => field(input, key)).find((v) => typeof v === "string")
      : undefined;
  const state = field(part, "state");
  const outcome =
    state === "output-available" ? "ok" : state === "output-error" ? "failed" : "no result";
  return `Tool: ${name}${typeof target === "string" ? ` \`${oneLine(target, 120)}\`` : ""} → ${outcome}`;
};

/** Who a message is from to a helper: another thread's message in a user's place isn't the user's. */
const speakerOf = (message: GramUIMessage): string => {
  if (message.role !== "user") return "Assistant";
  const origin = message.parts.find((part) => part.type === "data-thread-origin")?.data;
  if (origin === undefined) return "User";
  const sender = origin.feature === undefined ? "Thread" : "Worker";
  return `${sender} “${oneLine(origin.title, 80)}” (not the user)`;
};

/** A message as the lines a helper reads: its text under a speaker, its tool calls one line each. */
const messageBlock = (message: GramUIMessage): string | undefined => {
  if (message.metadata?.parentToolUseId !== undefined) return undefined;
  const lines: Array<string> = [];
  const texts: Array<string> = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim() !== "") texts.push(part.text.trim());
    } else if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      lines.push(toolLine(part, part.type));
    }
  }
  if (texts.length > 0) {
    lines.unshift(`${speakerOf(message)}: ${texts.join("\n\n")}`);
  }
  return lines.length === 0 ? undefined : lines.join("\n");
};

/**
 * `messages` fenced in `<conversation>` tags for a helper prompt, newest kept first within
 * `maxChars` (older ones are dropped whole, and a lone newest one too long is cut at its start),
 * token-shaped text scrubbed. The system prompt must declare the fenced text material, not a
 * message to the model: bare, "User: …" reads as a request, and the helper answers it.
 */
export const fenceConversation = (
  messages: ReadonlyArray<GramUIMessage>,
  options: { readonly maxChars: number },
): string => {
  const blocks = messages.flatMap((message) => {
    const block = messageBlock(message);
    return block === undefined ? [] : [redactText(block)];
  });
  const kept: Array<string> = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (used + block.length > options.maxChars) {
      if (kept.length === 0) kept.unshift(`…${block.slice(block.length - options.maxChars + 1)}`);
      break;
    }
    kept.unshift(block);
    used += block.length + 2;
  }
  return ["<conversation>", ...kept, "</conversation>"].join("\n\n");
};
