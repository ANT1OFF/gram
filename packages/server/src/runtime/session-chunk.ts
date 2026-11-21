import type { GramUIMessageChunk } from "@gram/contracts";

/** `chunk` without the fields that say who wrote or sent its message. */
export const withoutSender = (chunk: GramUIMessageChunk): GramUIMessageChunk => {
  if (!("messageMetadata" in chunk) || chunk.messageMetadata === undefined) return chunk;
  const metadata = chunk.messageMetadata as Record<string, unknown>;
  if (!("author" in metadata) && !("sentBy" in metadata)) return chunk;
  const { author: _author, sentBy: _sentBy, ...rest } = metadata;
  return { ...chunk, messageMetadata: rest } as GramUIMessageChunk;
};
