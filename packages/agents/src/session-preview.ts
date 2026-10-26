import type { SessionPreview } from "@gram/contracts";

const PREVIEW_CHARS = 240;

/** `text` on one line, capped for a preview; `undefined` when blank. */
export const previewLine = (text: string | undefined): string | undefined => {
  const line = text?.replaceAll(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
};

/** The first user text and the last assistant text of a session's messages, in order. */
export const previewOf = (
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string | undefined;
  }>,
): SessionPreview => {
  const firstPrompt = previewLine(
    messages.find((m) => m.role === "user" && previewLine(m.text) !== undefined)?.text,
  );
  const lastReply = previewLine(
    messages.findLast((m) => m.role === "assistant" && previewLine(m.text) !== undefined)?.text,
  );
  return {
    ...(firstPrompt === undefined ? {} : { firstPrompt }),
    ...(lastReply === undefined ? {} : { lastReply }),
  };
};
