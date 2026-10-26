import type { SessionTranscriptMessage, SessionTranscriptTool } from "@gram/contracts";
import { cutToolText, toolSideText } from "../transcript-text.ts";
import { toolOf } from "./mapper.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { Turn } from "./protocol/v2/Turn.ts";

/** An MCP result's text blocks joined; any other block is named rather than inlined. */
const mcpText = (content: ReadonlyArray<unknown>): string | undefined => {
  const parts = content.map((block) => {
    if (typeof block !== "object" || block === null) return String(block);
    const type = Reflect.get(block, "type");
    const text = Reflect.get(block, "text");
    return type === "text" && typeof text === "string" ? text : `[${String(type)}]`;
  });
  return parts.length === 0 ? undefined : cutToolText(parts.join("\n"));
};

const outputOf = (item: ThreadItem): string | undefined => {
  switch (item.type) {
    case "commandExecution": {
      if (item.status === "declined") return "Declined";
      const code =
        item.exitCode === null || item.exitCode === 0 ? "" : `\n[exit code ${item.exitCode}]`;
      return toolSideText(`${item.aggregatedOutput ?? ""}${code}`.trim());
    }
    case "fileChange":
      // A patch that applied says nothing its input didn't.
      return item.status === "declined"
        ? "Declined"
        : item.status === "failed"
          ? "The patch didn't apply"
          : undefined;
    case "mcpToolCall":
      return item.error !== null
        ? toolSideText(item.error.message)
        : item.result === null
          ? undefined
          : (mcpText(item.result.content) ?? toolSideText(item.result.structuredContent));
    case "dynamicToolCall":
      return toolSideText(item.contentItems);
    default:
      return undefined;
  }
};

const toolEntry = (item: ThreadItem): SessionTranscriptTool | undefined => {
  const tool = toolOf(item);
  if (tool === undefined) return undefined;
  const input =
    item.type === "commandExecution"
      ? toolSideText(Reflect.get(tool.input as object, "command"))
      : toolSideText(tool.input);
  const output = outputOf(item);
  return {
    name: tool.name,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
};

const userText = (item: Extract<ThreadItem, { type: "userMessage" }>): string =>
  item.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n")
    .trim();

/**
 * A past Codex thread in agent-neutral shape, from `thread/turns/list` with full items. A user
 * message and each of the agent's messages is one entry, stamped with its turn's start; a tool item
 * (a command, a patch, an MCP or dynamic tool call, a web search) joins the agent message before it
 * in the turn, as a Claude `tool_use` sits in the message that made it, or an entry of its own
 * when the turn opened with it. Tools are named as the live transcript names them (`toolOf`), with
 * both sides cut to size; a plan reads as the agent's text. Reasoning and hook prompts are left out,
 * and so are subagents, whose turns live in child threads this never reads. An item type this
 * build doesn't know is skipped.
 */
export const toCodexTranscript = (
  turns: ReadonlyArray<Turn>,
): ReadonlyArray<SessionTranscriptMessage> => {
  const out: Array<{
    role: SessionTranscriptMessage["role"];
    text: string;
    tools: Array<SessionTranscriptTool>;
    at: number | undefined;
  }> = [];
  for (const turn of turns) {
    const at = turn.startedAt === null ? undefined : turn.startedAt * 1000;
    let speaking: (typeof out)[number] | undefined;
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        speaking = undefined;
        const text = userText(item);
        if (text !== "") out.push({ role: "user", text, tools: [], at });
        continue;
      }
      if (item.type === "agentMessage" || item.type === "plan") {
        const text = item.text.trim();
        if (text === "") continue;
        speaking = { role: "assistant", text, tools: [], at };
        out.push(speaking);
        continue;
      }
      const tool = toolEntry(item);
      if (tool === undefined) continue;
      if (speaking === undefined) {
        speaking = { role: "assistant", text: "", tools: [], at };
        out.push(speaking);
      }
      speaking.tools.push(tool);
    }
  }
  return out.map(({ role, text, tools, at }) => ({
    role,
    text,
    ...(tools.length === 0 ? {} : { tools }),
    ...(at === undefined ? {} : { at }),
  }));
};
