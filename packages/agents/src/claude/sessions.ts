import type {
  importSessionToStore,
  SDKSessionInfo,
  SessionMessage,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentSessionSummary,
  SessionPreview,
  SessionTranscriptMessage,
  SessionTranscriptTool,
} from "@gram/contracts";

import { previewOf } from "../session-preview.ts";
import { cutToolText } from "../transcript-text.ts";

/** An SDK session listing entry in contract shape, with the most specific title available. */
export const toSessionSummary = (info: SDKSessionInfo): AgentSessionSummary => {
  const title = [info.customTitle, info.summary, info.firstPrompt]
    .map((candidate) => candidate?.trim())
    .find((candidate) => candidate !== undefined && candidate !== "");
  return {
    agentSessionId: info.sessionId,
    title: title ?? info.sessionId,
    updatedAt: info.lastModified,
    ...(info.firstPrompt ? { firstPrompt: info.firstPrompt } : {}),
    ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
    ...(info.cwd ? { cwd: info.cwd } : {}),
  };
};

/** A transcript entry's visible text: string content, or its text blocks joined; tool results have none. */
export const transcriptText = (message: unknown): string | undefined => {
  const content =
    typeof message === "object" && message !== null ? Reflect.get(message, "content") : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block: unknown) => {
    if (typeof block !== "object" || block === null || Reflect.get(block, "type") !== "text") {
      return [];
    }
    const text = Reflect.get(block, "text");
    return typeof text === "string" ? [text] : [];
  });
  return texts.length > 0 ? texts.join(" ") : undefined;
};

/** A past session's first prompt and last reply, from `getSessionMessages`; subagent turns don't count. */
export const toSessionPreview = (messages: ReadonlyArray<SessionMessage>): SessionPreview =>
  previewOf(
    messages
      .filter((m) => m.type !== "system" && m.parent_tool_use_id === null)
      .map((m) => ({
        role: m.type === "user" ? "user" : "assistant",
        text: transcriptText(m.message),
      })),
  );

/** A tool's input or result as text: strings as they are, text blocks joined, anything else as JSON. */
const toolText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value === "" ? undefined : cutToolText(value);
  if (Array.isArray(value)) {
    // A result's blocks; an image block is named rather than inlined as base64.
    const parts = value.map((block: unknown) => {
      if (typeof block !== "object" || block === null) return String(block);
      const type = Reflect.get(block, "type");
      const text = Reflect.get(block, "text");
      return type === "text" && typeof text === "string" ? text : `[${String(type)}]`;
    });
    return parts.length === 0 ? undefined : cutToolText(parts.join("\n"));
  }
  try {
    return cutToolText(JSON.stringify(value));
  } catch {
    // A cyclic value can't come off a JSONL transcript; this keeps a fake SDK from throwing here.
    return undefined;
  }
};

const blocksOf = (message: unknown): ReadonlyArray<Record<string, unknown>> => {
  const content =
    typeof message === "object" && message !== null ? Reflect.get(message, "content") : undefined;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block: unknown): block is Record<string, unknown> =>
      typeof block === "object" && block !== null,
  );
};

/**
 * A past session in agent-neutral shape, from `getSessionMessages`: the main conversation only,
 * text blocks as the message's text, each `tool_use` as a tool entry that the matching
 * `tool_result` (which the SDK files under a user message) completes. Thinking blocks are left
 * out, and a message with neither text nor tools disappears.
 */
export const toSessionTranscript = (
  messages: ReadonlyArray<SessionMessage>,
): ReadonlyArray<SessionTranscriptMessage> => {
  const out: Array<{
    role: SessionTranscriptMessage["role"];
    text: string;
    tools: Array<SessionTranscriptTool>;
  }> = [];
  const calls = new Map<string, { entry: (typeof out)[number]; index: number }>();
  for (const message of messages) {
    if (message.parent_tool_use_id !== null) continue;
    const entry: (typeof out)[number] = {
      role: message.type,
      text: (transcriptText(message.message) ?? "").trim(),
      tools: [],
    };
    for (const block of blocksOf(message.message)) {
      if (block["type"] === "tool_use") {
        const name = typeof block["name"] === "string" ? block["name"] : "tool";
        const input = toolText(block["input"]);
        entry.tools.push({ name, ...(input === undefined ? {} : { input }) });
        if (typeof block["id"] === "string") {
          calls.set(block["id"], { entry, index: entry.tools.length - 1 });
        }
      } else if (block["type"] === "tool_result") {
        const id = block["tool_use_id"];
        const call = typeof id === "string" ? calls.get(id) : undefined;
        const output = toolText(block["content"]);
        if (call !== undefined && output !== undefined) {
          call.entry.tools[call.index] = { ...call.entry.tools[call.index]!, output };
        }
      }
    }
    if (entry.text !== "" || entry.tools.length > 0) out.push(entry);
  }
  return out.map(({ role, text, tools }) => ({
    role,
    text,
    ...(tools.length === 0 ? {} : { tools }),
  }));
};

/**
 * The session's cost as its transcript last saved it (Claude Code's `cost-state` entry), which a
 * resumed or forked session starts its `total_cost_usd` from; 0 when there is none.
 */
export const savedSessionCost = async (
  readTranscript: typeof importSessionToStore,
  sessionId: string,
  dir: string,
): Promise<number> => {
  let saved = 0;
  const store = {
    append: async (_key: unknown, entries: ReadonlyArray<SessionStoreEntry>) => {
      for (const entry of entries) {
        const total = entry["totalCostUSD"];
        if (entry.type !== "cost-state" || entry["sessionId"] !== sessionId) continue;
        if (typeof total === "number" && Number.isFinite(total) && total >= 0) saved = total;
      }
    },
    load: async () => null,
  };
  // A fork can open in another worktree than the session it forks, whose transcript then sits
  // under the other checkout's project, which only the unscoped lookup finds.
  await readTranscript(sessionId, store, { dir }).catch(() => readTranscript(sessionId, store));
  return saved;
};
