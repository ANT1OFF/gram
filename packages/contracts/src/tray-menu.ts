import { isNoticeActionLabel, noticeBodyFits, noticePlain } from "./notice.ts";

// The menu bar's (tray's) asks and workspace status, as the page sends them and the shell shows
// them. Schema-free, for the shells' main processes.
//
// The menu bar can approve a command from outside the window, so it follows the notifications' rule
// (`notice.ts`): an Allow or Merge sits only under the exact command and its extras, shown whole
// (`noticeBodyFits`). Anything else offers Open only. The page builds the menu by that rule
// (`awayAsk`) and the shell holds it to it again.

/** The longest line a menu item shows; longer read-only lines end in "…". */
export const TRAY_LINE_MAX = 96;
/** The most lines an ask's submenu shows. */
export const TRAY_LINES_MAX = 6;
/** The most asks the menu lists; the rest are a count that opens the window. */
export const TRAY_ASKS_MAX = 8;
/** The most workspaces the menu lists. */
export const TRAY_WORKSPACES_MAX = 12;
/** The longest title or name the menu shows; longer ones end in "…". */
export const TRAY_TITLE_MAX = 64;

/** One ask in the menu. */
export interface TrayAsk {
  /** A page-made token, echoed back with what the user picks; never shown. */
  readonly id: string;
  /** The ask in a few words: "Allow git push × 3?". Never in place of `lines`. */
  readonly title: string;
  /** The workspace, then who asks. */
  readonly context: string;
  /** The exact command or call, then each of its extras: what an answer covers. */
  readonly lines: readonly string[];
  /** "Allow", "Allow 3" or "Merge"; absent when the menu offers Open only. */
  readonly answer?: string;
}

/** One workspace's line in the menu. */
export interface TrayWorkspace {
  /** A page-made token, echoed back when the user picks the line. */
  readonly id: string;
  readonly name: string;
  readonly busy: number;
  readonly asks: number;
  readonly failed: number;
}

/** What the page wants the menu to show. */
export interface TrayMenu {
  readonly asks: readonly TrayAsk[];
  /** Asks beyond `asks`, not listed. */
  readonly more: number;
  readonly workspaces: readonly TrayWorkspace[];
  /**
   * Whether every workspace is paused: the menu then offers Resume all, else Pause all. Absent with
   * no workspaces, and no item shows.
   */
  readonly allPaused?: boolean;
}

/**
 * What the user picked in the menu: an ask's answer, an ask or workspace to open, the rest, or
 * Pause all (`paused: true`) or Resume all (`paused: false`), as the item said.
 */
export type TrayAction =
  | { readonly kind: "answer"; readonly id: string }
  | { readonly kind: "open"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string }
  | { readonly kind: "asks" }
  | { readonly kind: "pauseAll"; readonly paused: boolean };

export const EMPTY_TRAY_MENU: TrayMenu = { asks: [], more: 0, workspaces: [] };

/**
 * Whether an answer may sit under `lines`: each one plain on its own (a line holding a line break
 * would be two), and all of them shown whole.
 */
export const trayAnswerable = (lines: readonly string[], answer: unknown): answer is string =>
  isNoticeActionLabel(answer) &&
  lines.length > 0 &&
  lines.every(noticePlain) &&
  noticeBodyFits(lines.join("\n"));

/** Text for a menu item: hiding characters dropped, whitespace one space, at most `max`. */
export const trayText = (text: string, max = TRAY_TITLE_MAX): string => {
  const plain = [...text.replace(/\s+/g, " ").trim()].filter((char) => noticePlain(char));
  return plain.length <= max ? plain.join("") : `${plain.slice(0, max - 1).join("")}…`;
};
