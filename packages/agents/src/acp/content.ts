import type { SessionTranscriptMessage, SlashCommand, UserInput } from "@gram/contracts";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { type Json, record, records, text } from "./json.ts";

const IMAGE_INLINE_MAX = 10 * 1024 * 1024;

/**
 * A message as ACP content: its text, each image inline, and every other attachment as a link to
 * its file, which the agent reads with its own tools.
 */
export const promptOf = async (
  input: UserInput,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<ReadonlyArray<Json>> => {
  const blocks: Array<Json> = [{ type: "text", text: input.text }];
  for (const attachment of input.attachments ?? []) {
    const name = attachment.name ?? attachment.path.split(/[\\/]/).at(-1) ?? attachment.path;
    if (attachment.mediaType?.startsWith("image/") === true) {
      const bytes = await read(attachment.path).catch(() => undefined);
      if (bytes !== undefined && bytes.byteLength <= IMAGE_INLINE_MAX) {
        blocks.push({
          type: "image",
          mimeType: attachment.mediaType,
          data: Buffer.from(bytes).toString("base64"),
        });
        continue;
      }
    }
    blocks.push({
      type: "resource_link",
      uri: pathToFileURL(attachment.path).href,
      name,
      ...(attachment.mediaType === undefined ? {} : { mimeType: attachment.mediaType }),
    });
  }
  return blocks;
};

/** An `available_commands_update` as Gram's slash commands. */
export const commandsOf = (update: Json): ReadonlyArray<SlashCommand> =>
  records(update["availableCommands"]).flatMap((command): Array<SlashCommand> => {
    const name = text(command["name"]);
    if (name === undefined || name === "") return [];
    const hint = text(record(command["input"])["hint"]);
    return [
      {
        name,
        description: text(command["description"]) ?? "",
        ...(hint === undefined ? {} : { argumentHint: hint }),
      },
    ];
  });

/**
 * A past session's main conversation from the updates `session/load` replays: each user message,
 * and each reply with the calls it made, in order, the calls named by `toolName`.
 */
export const transcriptOf = (
  updates: ReadonlyArray<Json>,
  toolName: (update: Json) => string,
): Array<SessionTranscriptMessage> => {
  const messages: Array<SessionTranscriptMessage> = [];
  let last:
    | { role: "user" | "assistant"; text: string; tools: Array<{ name: string }>; at?: number }
    | undefined;
  const flush = () => {
    if (last === undefined) return;
    if (last.text.trim() !== "" || last.tools.length > 0)
      messages.push({
        role: last.role,
        text: last.text.trim(),
        ...(last.tools.length > 0 ? { tools: last.tools } : {}),
        ...(last.at === undefined ? {} : { at: last.at }),
      });
    last = undefined;
  };
  for (const params of updates) {
    const update = record(params["update"]);
    const kind = update["sessionUpdate"];
    const stamp = record(params["_meta"])["agentTimestampMs"];
    const at = typeof stamp === "number" ? stamp : undefined;
    const role =
      kind === "user_message_chunk"
        ? "user"
        : kind === "agent_message_chunk" || kind === "tool_call"
          ? "assistant"
          : undefined;
    if (role === undefined) continue;
    if (last?.role !== role) {
      flush();
      last = { role, text: "", tools: [], ...(at === undefined ? {} : { at }) };
    }
    if (kind === "tool_call") last.tools.push({ name: toolName(update) });
    else last.text += text(record(update["content"])["text"]) ?? "";
  }
  flush();
  return messages;
};
