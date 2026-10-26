// The orchestrator's "/" verbs in the Orchestrator layout: a word each for what the workspace's home
// does most, and More… for everything else in ⌘K. No React here.

/** What a verb does; each runs an action Gram already has elsewhere. */
export type VerbId =
  | "task"
  | "pause"
  | "resume"
  | "memory"
  | "board"
  | "files"
  | "repo"
  | "fresh"
  | "more";

export interface Verb {
  readonly id: VerbId;
  /** The one word shown. */
  readonly label: string;
  /** What is typed after `/` to pick it. */
  readonly name: string;
}

/** Verbs per row of the menu's grid; the arrow keys move by it. */
export const VERB_COLUMNS = 4;

const verb = (id: VerbId, label: string): Verb => ({
  id,
  label,
  name: label.replace(/…$/, "").toLowerCase(),
});

const MORE = verb("more", "More…");

/**
 * The verbs, in the design's order, More… last: at most `MENU_CAP` before it. `paused` is the workspace's state, which Pause
 * reads as Resume; `undefined` while it isn't known leaves the verb out rather than guess. Files took
 * Settings' place to stay within the cap: Settings is ⌘, everywhere and in More….
 */
export function orchestratorVerbs(paused: boolean | undefined): Verb[] {
  const verbs = [
    verb("task", "Task"),
    ...(paused === undefined ? [] : [paused ? verb("resume", "Resume") : verb("pause", "Pause")]),
    verb("memory", "Memory"),
    verb("board", "Board"),
    verb("files", "Files"),
    verb("repo", "Repo"),
    verb("fresh", "Fresh"),
  ];
  return [...verbs, MORE];
}

/**
 * The verbs whose name starts with what is typed after `/`, then More…, which stays as the way to
 * the rest. Empty when nothing matches, so the agent's own commands can answer instead.
 */
export function filterVerbs(verbs: readonly Verb[], query: string): Verb[] {
  const q = query.toLowerCase();
  const more = verbs.find((v) => v.id === "more");
  const matched = verbs.filter((v) => v.id !== "more" && v.name.startsWith(q));
  if (matched.length === 0 && (more === undefined || !more.name.startsWith(q))) return [];
  return more === undefined ? matched : [...matched, more];
}

/**
 * The option a key moves to in a grid of `count` options, `columns` a row: ← → step and wrap, ↑ ↓
 * go a row and wrap to the same column at the other end. `undefined` for any other key.
 */
export function gridIndexForKey(
  key: string,
  active: number,
  count: number,
  columns: number,
): number | undefined {
  if (count === 0) return undefined;
  const column = active % columns;
  const lastRow = Math.floor((count - 1) / columns) * columns;
  switch (key) {
    case "ArrowRight":
      return (active + 1) % count;
    case "ArrowLeft":
      return (active - 1 + count) % count;
    case "ArrowDown": {
      const next = active + columns;
      return next < count ? next : column;
    }
    case "ArrowUp": {
      const next = active - columns;
      if (next >= 0) return next;
      const bottom = lastRow + column;
      return bottom < count ? bottom : bottom - columns;
    }
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
