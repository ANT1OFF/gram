import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ghostty, type GhosttyCell, type GhosttyTerminal } from "ghostty-web";

/** The size replayed at when the terminal's own isn't known; the Terminal tab's default. */
const FALLBACK = { cols: 120, rows: 30 } as const;

/**
 * Ghostty counts scrollback in bytes of page memory, not lines. Room for the whole capped
 * scrollback at any sane width, so "truncated" means the caller's limit, not ours.
 */
const SCROLLBACK_BYTES = 64 * 1024 * 1024;

/**
 * Compiled once; every replay instantiates it afresh. A fresh instance is the point, not an
 * economy: ghostty-web 0.4.0 hands a new terminal the unzeroed pages of one freed in the same
 * instance (coder/ghostty-web#141), so a shared instance would show one thread's terminal in
 * another's read. A new instance's memory is zeroed, costs about a millisecond, and is collected
 * whole, which WebAssembly memory that only ever grows otherwise never is.
 */
let compiled: Promise<WebAssembly.Module> | undefined;
const ghosttyModule = (): Promise<WebAssembly.Module> =>
  (compiled ??= readFile(wasmPath()).then((bytes) => WebAssembly.compile(bytes)));

/**
 * Out of the package when there is one (vitest, `node src/main.ts`). The desktop build bundles the
 * server and ships no `node_modules` for it, so `electron.vite.server.config.ts` puts the file
 * beside the bundle instead.
 */
const wasmPath = (): string => {
  try {
    return createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm");
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), "ghostty-vt.wasm");
  }
};

const rowText = (cells: ReadonlyArray<GhosttyCell>, grapheme: (x: number) => string): string =>
  cells
    // Cells never written to, not spaces a program wrote: a line that wraps at a space keeps it.
    .slice(0, cells.findLastIndex((cell) => cell.codepoint !== 0) + 1)
    .map((cell, x) => {
      // The spacer half of a wide character.
      if (cell.width === 0) return "";
      if (cell.codepoint === 0) return " ";
      return cell.grapheme_len > 0 ? grapheme(x) : String.fromCodePoint(cell.codepoint);
    })
    .join("");

/**
 * Feeds `bytes` to the terminal and returns, per scrollback row, whether it soft-wrapped from the
 * row above. Ghostty only answers that for rows still on screen, so it is asked before each small
 * write and remembered for the rows that write scrolls off. `undefined` when the scrollback shrank
 * other than by being cleared, which is Ghostty pruning it: the remembered rows no longer line up.
 */
const replay = (terminal: GhosttyTerminal, bytes: Uint8Array): Array<boolean> | undefined => {
  let wrapped: Array<boolean> | undefined = [];
  let start = 0;
  while (start < bytes.length) {
    // To the next newline, or a row's worth: either way the write scrolls a row or two at most.
    const newline = bytes.indexOf(0x0a, start);
    const end = Math.min(newline === -1 ? bytes.length : newline + 1, start + terminal.cols);
    const onScreen = Array.from({ length: terminal.rows }, (_, y) => terminal.isRowWrapped(y));
    terminal.write(bytes.subarray(start, end));
    start = end;
    if (wrapped === undefined) continue;
    const length = terminal.getScrollbackLength();
    if (length === 0) wrapped = [];
    else if (length < wrapped.length) wrapped = undefined;
    // A scroll sequence can push more rows than the screen held; those were not wrapped text.
    else for (let i = 0; wrapped.length < length; i++) wrapped.push(onScreen[i] ?? false);
  }
  return wrapped;
};

/**
 * What a newly opened Terminal tab would show for this output, as plain text: the last `lines` lines
 * of screen and scrollback after the raw PTY output has been replayed through a terminal emulator,
 * the same one the tab draws with, from the same replay (`Scrollback.toReplay`) the tab is sent when
 * it attaches, so the two cannot disagree.
 * Stripping escape sequences instead would hand back text the screen no longer holds: what `clear`
 * wiped, every frame of a progress bar, and the shell behind a full-screen program. Replayed, a
 * cleared screen is clear, a redrawn line is its last state, and while `vim` or `less` has the
 * alternate screen, that is what comes back.
 *
 * `cut` says output older than `raw` was dropped at the scrollback cap, which counts as truncated.
 * Trailing blank rows, which every screen has below its cursor, don't count.
 */
export const plainTail = async (
  raw: string,
  lines: number,
  size: { readonly cols: number; readonly rows: number } = FALLBACK,
  cut = false,
): Promise<{ readonly text: string; readonly truncated: boolean }> => {
  const instance = await WebAssembly.instantiate(await ghosttyModule(), {
    // Ghostty's own diagnostics, which can quote what the terminal was sent. Never logged.
    env: { log: () => {} },
  });
  const terminal = new Ghostty(instance).createTerminal(
    Math.max(size.cols, 2),
    Math.max(size.rows, 1),
    { scrollbackLimit: SCROLLBACK_BYTES },
  );
  const wrapped = replay(terminal, new TextEncoder().encode(raw));
  terminal.update();

  const all: Array<string> = [];
  // A row that soft-wrapped continues the line above; rejoin it as the program wrote it.
  const add = (text: string, continues: boolean) => {
    if (continues && all.length > 0) all[all.length - 1] += text;
    else all.push(text);
  };
  const scrollback = terminal.getScrollbackLength();
  for (let i = 0; i < scrollback; i++) {
    const cells = terminal.getScrollbackLine(i);
    if (cells === null) continue;
    add(
      rowText(cells, (x) => terminal.getScrollbackGraphemeString(i, x)),
      wrapped?.[i] ?? false,
    );
  }
  for (let y = 0; y < terminal.rows; y++) {
    const cells = terminal.getLine(y);
    if (cells === null) continue;
    add(
      rowText(cells, (x) => terminal.getGraphemeString(y, x)),
      terminal.isRowWrapped(y),
    );
  }
  terminal.free();

  while (all.length > 0 && all.at(-1)!.trim() === "") all.pop();
  const kept = all.slice(-lines);
  return {
    text: kept.map((line) => line.trimEnd()).join("\n"),
    truncated: cut || kept.length < all.length,
  };
};
