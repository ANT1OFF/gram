/**
 * Text with `backtick` spans rendered as inline code, in one span so a flex parent (a tooltip)
 * lays it out as one run of text instead of a column per part.
 */
export function CommandText({ text }: { text: string }) {
  return (
    <span>
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded-sm bg-muted px-1 font-mono text-[0.9em]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  );
}
