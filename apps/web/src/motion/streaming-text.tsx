import { useState } from "react";

import { cn } from "@/lib/utils";

import { useLookMotion } from "./hooks";

export interface StreamSegments {
  text: string;
  /** Settled text, rendered without animation. */
  head: string;
  /** Recently appended chunks, each fading in, keyed by start offset. */
  segments: { start: number; text: string }[];
}

export const initialSegments = (text: string): StreamSegments => ({
  text,
  head: text,
  segments: [],
});

/**
 * Advances the segmentation for new `text`. Appends become a new animated segment; anything that
 * isn't an append (an edit or a new message) settles immediately. At most `maxAnimated` segments
 * stay animated; older ones fold into the head.
 */
export function nextSegments(prev: StreamSegments, text: string, maxAnimated = 24): StreamSegments {
  if (text === prev.text) return prev;
  if (!text.startsWith(prev.text)) return initialSegments(text);
  const segments = [
    ...prev.segments,
    { start: prev.text.length, text: text.slice(prev.text.length) },
  ];
  let head = prev.head;
  while (segments.length > maxAnimated) head += segments.shift()!.text;
  return { text, head, segments };
}

/** Renders streamed text with each appended chunk fading in, plus a caret while `streaming`. */
export function StreamingText({
  text,
  streaming,
  className,
}: {
  text: string;
  streaming: boolean;
  className?: string;
}) {
  const look = useLookMotion();
  const [state, setState] = useState(() => initialSegments(text));
  const next = nextSegments(state, text);
  if (next !== state) setState(next);

  return (
    <span
      className={cn("gram-stream", className)}
      data-reveal={look.reveal}
      data-caret-blink={look.caretBlink}
    >
      {next.head}
      {next.segments.map((segment) => (
        <span key={segment.start} className="gram-stream-chunk">
          {segment.text}
        </span>
      ))}
      {streaming && <span aria-hidden className="gram-caret" />}
    </span>
  );
}
