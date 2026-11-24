import * as Schema from "effect/Schema";

/** Cap on each side of a tool call in a transcript read back; a dream needs the gist, not the bytes. */
export const TRANSCRIPT_TOOL_MAX_CHARS = 4096;

/**
 * `text` cut to `TRANSCRIPT_TOOL_MAX_CHARS`, saying how long it was. The cut backs off to before the
 * word it lands in: the server scrubs secrets out of this text later, and half a key no longer
 * looks like one to its patterns.
 */
export const cutToolText = (text: string): string =>
  text.length <= TRANSCRIPT_TOOL_MAX_CHARS
    ? text
    : `${text.slice(0, TRANSCRIPT_TOOL_MAX_CHARS).replace(/[\w.~+/=-]{1,256}$/, "")}… [truncated: ${text.length} characters in all]`;

/**
 * One side of a tool call as transcript text: a string as it is, anything else as JSON, both cut to
 * size. `undefined` for nothing worth a line: no value, an empty string, an empty object.
 */
export const toolSideText = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return cutToolText(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined || json === "{}" ? undefined : cutToolText(json);
  } catch {
    return undefined;
  }
};

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

/** A content block's text when it is a `{ type: "text" }` block; undefined for any other block. */
export const blockText = (block: unknown): string | undefined =>
  Schema.is(TextBlock)(block) ? block.text : undefined;

/** A content block as one line of a tool's result: a text block's text, else `[its type]`. */
export const blockLine = (block: unknown): string => {
  if (typeof block !== "object" || block === null) return String(block);
  return blockText(block) ?? `[${String("type" in block ? block.type : undefined)}]`;
};

/** The `content` an SDK transcript message carries, read off a message of unknown shape. */
export const contentOf = (message: unknown): unknown =>
  typeof message === "object" && message !== null && "content" in message
    ? message.content
    : undefined;
