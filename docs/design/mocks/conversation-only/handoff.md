# Conversation only: handoff

## Target

`v1.html`, board **A Clean**.

## Decisions

- One switch for every thread, kept across launches. Off by default.
- On: tool calls, commands, reasoning, memory changes and the turn's fold row draw nothing, and
  every word the agent wrote shows. A reply of nothing but work draws no row.
- A running turn shows "Working" and its time under the last row. Not while it waits on the reader.
- Questions, approvals, errors, images, published pages and files, and the plan stay.

## Parts

- The header button is `ConversationOnlyButton` (`apps/web/src/thread/conversation-only-toggle.tsx`):
  the bare glyph while off, pressed with its name while on.
- `.live` becomes `WorkingLine` (`apps/web/src/thread/working-line.tsx`), one of the transcript's
  tail lines.
- What counts as work is `isWork` (`apps/web/src/thread/conversation-only.ts`).

## Deviations allowed

- The plan stays where the product has it, in its strip under the header, not as a card in the
  transcript.
- Not allowed: hiding a question, an approval or an error card.

## Gaps

None. Since the first build: ⌘⌥5 switches it, and an image a tool call returned stays as a
thumbnail where the call was.
