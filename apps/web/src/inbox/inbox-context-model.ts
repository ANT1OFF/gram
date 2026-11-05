import { changedFilesOf, type GramUIMessage } from "@gram/contracts";

// What the Inbox's detail pane shows of the thread an item came from, under the item: its last few
// turns and what its edits changed, so an ask can be answered without opening the thread. Pure, so
// it is tested without a browser.

/** How many of the thread's latest turns the pane shows. */
export const CONTEXT_TURNS = 4;

/** How long a turn's words run before they are cut short; the pane clamps them to lines too. */
const TURN_CHARS = 320;

export interface ContextTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  /** Its words, on one paragraph, cut short with "…" past `TURN_CHARS`. */
  readonly text: string;
}

export interface InboxContext {
  /** The latest turns with words, oldest first. */
  readonly turns: readonly ContextTurn[];
  /** Files the loaded turns' edits changed. */
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

const wordsOf = (message: GramUIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const cut = (text: string): string =>
  text.length <= TURN_CHARS ? text : `${text.slice(0, TURN_CHARS - 1).trimEnd()}…`;

/**
 * The thread's last `CONTEXT_TURNS` turns that say something (a tool call alone says nothing), and
 * the sum of what its edits changed.
 */
export const inboxContextOf = (messages: readonly GramUIMessage[]): InboxContext => {
  const turns: ContextTurn[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.length < CONTEXT_TURNS; i--) {
    const message = messages[i]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = wordsOf(message);
    if (text === "") continue;
    turns.unshift({ id: message.id, role: message.role, text: cut(text) });
  }
  const files = changedFilesOf(messages);
  return {
    turns,
    files: files.length,
    additions: files.reduce((n, file) => n + file.additions, 0),
    deletions: files.reduce((n, file) => n + file.deletions, 0),
  };
};
