import { useMemo } from "react";
import { HighlightedCode } from "@/components/ai-elements/code-block";
import { canHighlightCode } from "@/lib/code-highlighting";

/** Whole completed objects/arrays only; classify within grammar limits before parsing. */
export const isJsonOutput = (text: string): boolean => {
  if (!canHighlightCode(text)) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** Classification never replaces the original output with a reserialized value. */
export function JsonText({
  text,
  stable,
  serialized = false,
}: {
  text: string | undefined;
  stable: boolean;
  serialized?: boolean;
}) {
  const enabled = useMemo(
    () =>
      stable && text !== undefined && (serialized ? canHighlightCode(text) : isJsonOutput(text)),
    [text, stable, serialized],
  );
  return enabled && text !== undefined ? <HighlightedCode code={text} language="json" /> : text;
}
