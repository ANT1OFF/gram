/**
 * A thread's name wherever a row or a hint names it: its title, or "Untitled" while it has none,
 * and for one not loaded. An action that opens a thread is worded as the action instead.
 */
export const threadDisplayTitle = (thread: { readonly title: string } | undefined): string =>
  thread?.title || "Untitled";
