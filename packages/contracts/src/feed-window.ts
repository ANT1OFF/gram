/**
 * How many turns a thread feed's `messages` head and each `thread.history` page hold, counted in
 * user messages: enough to fill a view and scroll a while, without reading a weeks-long thread.
 */
export const FEED_WINDOW_TURNS = 20;

/**
 * The messages before `beforeId` (all of them without it), from the `turns`th user message back
 * on, and whether any come before those: the window the server reads with SQL, over an array.
 */
export function recentTurns<M extends { readonly id: string; readonly role: string }>(
  messages: ReadonlyArray<M>,
  turns: number,
  beforeId?: string,
): { messages: ReadonlyArray<M>; earlier: boolean } {
  const end =
    beforeId === undefined ? messages.length : messages.findIndex((m) => m.id === beforeId);
  if (end === -1) return { messages: [], earlier: false };
  let start = end;
  let seen = 0;
  while (start > 0 && seen < turns) {
    start--;
    if (messages[start]!.role === "user") seen++;
  }
  return { messages: messages.slice(start, end), earlier: start > 0 };
}
