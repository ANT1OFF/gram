import type { ITheme } from "ghostty-web";

import { findMatches, nextActive, type FindMatch, type FindRow } from "./find-model";
import type { PathLink } from "./links";
import { quietRenderLoop } from "./render-loop";
import { loadTerminalFont, waitForTerminalFont } from "./terminal-font";

export type TerminalTheme = ITheme;

interface TerminalLinks {
  onUrl(url: string): void;
  findPaths(text: string): readonly PathLink[];
  onPath(link: PathLink): void;
}

/** Find-match highlight colours, laid over the text, so they must let it show through. */
export interface TerminalSearchColors {
  match: string;
  activeMatch: string;
  activeMatchBorder: string;
}

interface TerminalFindOptions {
  caseSensitive: boolean;
  regex: boolean;
  colors: TerminalSearchColors;
}

export interface TerminalFindResults {
  /** The active match, -1 when there is none. */
  index: number;
  count: number;
}

/** The slice of the emulator the Terminal tab uses; a seam so component tests can swap in a fake. */
export interface TerminalHandle {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  reset(): void;
  focus(): void;
  /** Fits the grid to the container. */
  fit(): void;
  /** Whether the terminal can be seen. One that can't keeps its state up to date but isn't drawn. */
  setVisible(visible: boolean): void;
  setFont(fontFamily: string): void;
  setFontSize(fontSize: number): void;
  onData(listener: (data: string) => void): void;
  /** Types `data` as a paste (bracketed when the shell asked for it), through `onData`. */
  paste(data: string): void;
  /**
   * Return false from `filter` to keep a key event from the shell. The event is then
   * default-prevented, so the app's own shortcut dispatch, which skips prevented events, won't see
   * it: a filter that means to leave a key to the app has to dispatch it itself.
   */
  setKeyFilter(filter: (event: KeyboardEvent) => boolean): void;
  setLinks(links: TerminalLinks): void;
  /** Selects the next match; `incremental` keeps the current one while it still matches. */
  findNext(term: string, options: TerminalFindOptions, incremental?: boolean): boolean;
  findPrevious(term: string, options: TerminalFindOptions): boolean;
  /** Removes the match highlights and the selected match. */
  clearFind(): void;
  onFindResults(listener: (results: TerminalFindResults) => void): void;
  /** The selected text, "" when nothing is selected. */
  getSelection(): string;
  dispose(): void;
}

/**
 * There is no `setTheme`: Ghostty resolves a cell's colours against the palette as it is written,
 * and the palette is fixed when the terminal is made. A new theme means a new terminal and a replay.
 */
export interface TerminalOptions {
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  /** Grid dimensions changed, including after font readiness without a container resize. */
  onResize?: (cols: number, rows: number) => void;
}

const SCROLLBACK_BYTES = 4 * 1024 * 1024;
const MAX_HIGHLIGHTS = 500;
const MIRROR_DELAY_MS = 100;

let compiled: Promise<WebAssembly.Module> | undefined;
const ghosttyModule = (): Promise<WebAssembly.Module> =>
  (compiled ??= import("ghostty-web/ghostty-vt.wasm?url")
    .then(({ default: url }) => fetch(url))
    .then((response) => {
      if (!response.ok) throw new Error(`terminal emulator: HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error: unknown) => {
      compiled = undefined;
      throw error;
    }));

function openLeavingFocusWhereItIs(
  terminal: { focus(): void; open(parent: HTMLElement): void },
  parent: HTMLElement,
) {
  terminal.focus = () => {};
  try {
    terminal.open(parent);
  } finally {
    delete (terminal as { focus?: unknown }).focus;
  }
}

/**
 * Loads ghostty-web on first use and opens a terminal in `element` (canvas renderer).
 *
 * Every terminal gets a WebAssembly instance of its own, and so does every `reset()`. ghostty-web
 * 0.4.0 hands a new terminal the unzeroed pages of one freed in the same instance
 * (coder/ghostty-web#141): with the shared instance it defaults to, a thread's closed terminal
 * showed up in the next one opened, and its own `reset()` frees and remakes in place, so it is never
 * called. A fresh instance's memory is zeroed, takes a millisecond or two to make, and is collected
 * whole when its terminal goes.
 */
export async function createTerminal(
  element: HTMLElement,
  options: TerminalOptions,
): Promise<TerminalHandle> {
  const ready = loadTerminalFont(options.fontFamily, options.fontSize);
  const [{ Ghostty, Terminal, UrlRegexProvider }, wasm] = await Promise.all([
    import("ghostty-web"),
    ghosttyModule(),
    waitForTerminalFont(ready),
  ]);

  element.style.position = "relative";
  const highlights = document.createElement("div");
  highlights.style.cssText = "position:absolute;inset:0;pointer-events:none";
  highlights.setAttribute("aria-hidden", "true");
  const mirror = document.createElement("pre");
  mirror.dataset["terminalText"] = "";
  mirror.setAttribute("role", "document");
  mirror.setAttribute("aria-label", "Terminal output");
  mirror.setAttribute("aria-live", "off");
  mirror.style.cssText =
    "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:pre";
  element.append(highlights, mirror);

  let links: TerminalLinks | undefined;
  let dataListener: ((data: string) => void) | undefined;
  let keyFilter: ((event: KeyboardEvent) => boolean) | undefined;
  let font = { family: options.fontFamily, size: options.fontSize };
  let written = false;
  let visible = true;
  let disposed = false;
  let fontVersion = 0;

  const open = () => {
    const instance = new WebAssembly.Instance(wasm, {
      env: { log: () => {} },
    });
    const made = new Terminal({
      ghostty: new Ghostty(instance),
      theme: options.theme,
      fontFamily: font.family,
      fontSize: font.size,
      cursorBlink: true,
      scrollback: SCROLLBACK_BYTES,
    });
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0;padding:inherit;outline:none";
    element.prepend(host);
    openLeavingFocusWhereItIs(made, host);

    host.addEventListener(
      "beforeinput",
      (event) => {
        if (event.inputType === "insertText" && !event.isComposing && event.data) {
          dataListener?.(event.data);
        }
      },
      { capture: true },
    );

    const selection =
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ghostty-web keeps its selection manager private; this only turns off its own clipboard copy when it has one
      (made as unknown as { selectionManager?: { copyToClipboard?: (text: string) => unknown } })
        .selectionManager;
    if (selection !== undefined) selection.copyToClipboard = () => {};

    const loop = quietRenderLoop(made, visible);

    const urls = new UrlRegexProvider(made);
    made.registerLinkProvider({
      provideLinks: (y, callback) =>
        urls.provideLinks(y, (found) =>
          callback(found?.map((link) => ({ ...link, activate: () => links?.onUrl(link.text) }))),
        ),
    });
    made.registerLinkProvider({
      provideLinks: (y, callback) => {
        const row = readRow(y);
        const found = row === undefined ? [] : (links?.findPaths(row.text) ?? []);
        callback(
          found.length === 0
            ? undefined
            : found.map((link) => ({
                text: row!.text.slice(link.start, link.end),
                range: {
                  start: { x: row!.columns[link.start]!, y },
                  end: { x: row!.columns[link.end]! - 1, y },
                },
                activate: () => links?.onPath(link),
              })),
        );
      },
    });
    made.onData((data) => dataListener?.(data));
    made.attachCustomKeyEventHandler((event) => keyFilter !== undefined && !keyFilter(event));
    made.onScroll(() => {
      drawHighlights();
      mirrorSoon();
    });
    made.onResize(() => {
      options.onResize?.(made.cols, made.rows);
      refindSoon();
      mirrorSoon();
    });
    return { terminal: made, host, loop };
  };
  const close = () => {
    current.loop.dispose();
    current.terminal.dispose();
    current.host.remove();
  };

  const metrics = () => current.terminal.renderer!.getMetrics();
  const fit = () => {
    const { terminal } = current;
    const { width, height } = metrics();
    if (width === 0 || height === 0 || element.clientWidth === 0 || element.clientHeight === 0)
      return;
    const style = getComputedStyle(element);
    const across = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const down = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const cols = Math.max(2, Math.floor((element.clientWidth - (across || 0)) / width));
    const rows = Math.max(1, Math.floor((element.clientHeight - (down || 0)) / height));
    if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
    element.dataset["cols"] = String(terminal.cols);
    element.dataset["rows"] = String(terminal.rows);
  };

  const viewportTop = () =>
    current.terminal.getScrollbackLength() - Math.floor(current.terminal.getViewportY());
  const readRow = (y: number): FindRow | undefined => {
    const line = current.terminal.buffer.active.getLine(y);
    if (line === undefined) return undefined;
    let text = "";
    const columns: number[] = [];
    let next = 0;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell === undefined || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) columns.push(x);
      text += chars;
      next = x + cell.getWidth();
    }
    columns.push(next);
    const end = text.trimEnd().length;
    return {
      text: text.slice(0, end),
      wrapped: line.isWrapped,
      columns: columns.slice(0, end + 1),
    };
  };

  let mirrorTimer: ReturnType<typeof setTimeout> | undefined;
  const mirrorNow = () => {
    mirrorTimer = undefined;
    const top = viewportTop();
    const text = Array.from(
      { length: current.terminal.rows },
      (_, y) => readRow(top + y)?.text ?? "",
    )
      .join("\n")
      .trimEnd();
    if (mirror.textContent !== text) mirror.textContent = text;
  };
  const mirrorSoon = () => {
    mirrorTimer ??= setTimeout(mirrorNow, MIRROR_DELAY_MS);
  };

  let find:
    | { term: string; options: TerminalFindOptions; matches: FindMatch[]; active: number }
    | undefined;
  let findListener: ((results: TerminalFindResults) => void) | undefined;
  let refindFrame: number | undefined;

  const drawHighlights = () => {
    highlights.replaceChildren();
    if (find === undefined) return;
    const { width, height } = metrics();
    const top = viewportTop();
    const { matches, active, options: findOptions } = find;
    const style = getComputedStyle(element);
    const left = Number.parseFloat(style.paddingLeft) || 0;
    const above = Number.parseFloat(style.paddingTop) || 0;
    let drawn = 0;
    for (let i = 0; i < matches.length && drawn < MAX_HIGHLIGHTS; i++) {
      for (const segment of matches[i]!) {
        const y = segment.row - top;
        if (y < 0 || y >= current.terminal.rows) continue;
        const box = document.createElement("div");
        box.dataset["terminalFindMatch"] = i === active ? "active" : "";
        box.style.cssText = `position:absolute;left:${left + segment.column * width}px;top:${above + y * height}px;width:${segment.width * width}px;height:${height}px`;
        box.style.backgroundColor =
          i === active ? findOptions.colors.activeMatch : findOptions.colors.match;
        if (i === active) box.style.outline = `1px solid ${findOptions.colors.activeMatchBorder}`;
        highlights.append(box);
        drawn++;
      }
    }
  };

  const search = (
    term: string,
    findOptions: TerminalFindOptions,
    step: "next" | "previous" | "incremental" | "refresh",
  ): boolean => {
    const { terminal } = current;
    const rows: FindRow[] = [];
    for (let y = 0; y < terminal.buffer.active.length; y++)
      rows.push(readRow(y) ?? { text: "", wrapped: false, columns: [] });
    const matches = findMatches(rows, { term, ...findOptions });
    const previous = find?.matches[find.active];
    const active = nextActive(
      matches,
      previous,
      step === "refresh" ? "incremental" : step,
      viewportTop(),
    );
    find = { term, options: findOptions, matches, active };
    const row = matches[active]?.[0]?.row;
    if (row !== undefined && step !== "refresh") {
      const top = viewportTop();
      if (row < top || row >= top + terminal.rows) {
        const wantedTop = Math.max(0, row - Math.floor(terminal.rows / 2));
        terminal.scrollToLine(Math.max(0, terminal.getScrollbackLength() - wantedTop));
      }
    }
    drawHighlights();
    findListener?.({ index: active, count: matches.length });
    return matches.length > 0;
  };
  const refindSoon = () => {
    if (find === undefined || refindFrame !== undefined) return;
    refindFrame = requestAnimationFrame(() => {
      refindFrame = undefined;
      if (find !== undefined) search(find.term, find.options, "refresh");
    });
  };

  const fontLoaded = (loading: Promise<void>, version: number) => {
    void loading.then(() => {
      if (disposed || version !== fontVersion) return;
      const { terminal, loop } = current;
      terminal.renderer!.remeasureFont();
      terminal.renderer!.resize(terminal.cols, terminal.rows);
      fit();
      drawHighlights();
      loop.redraw();
    });
  };

  let current = open();
  element.dataset["fontSize"] = String(font.size);
  fit();
  mirrorSoon();
  fontLoaded(ready, fontVersion);

  return {
    get cols() {
      return current.terminal.cols;
    },
    get rows() {
      return current.terminal.rows;
    },
    write: (data) => {
      if (data === "") return;
      written = true;
      current.terminal.write(data);
      current.loop.wake();
      refindSoon();
      mirrorSoon();
    },
    reset: () => {
      if (!written) return;
      const focused = element.contains(document.activeElement);
      close();
      current = open();
      written = false;
      fit();
      if (focused) current.terminal.focus();
      refindSoon();
      mirrorSoon();
    },
    focus: () => current.terminal.focus(),
    fit,
    setVisible: (next) => {
      visible = next;
      current.loop.setVisible(next);
    },
    setFont: (fontFamily) => {
      if (font.family === fontFamily) return;
      font = { ...font, family: fontFamily };
      current.terminal.options.fontFamily = fontFamily;
      fit();
      drawHighlights();
      current.loop.redraw();
      fontLoaded(loadTerminalFont(font.family, font.size), ++fontVersion);
    },
    setFontSize: (fontSize) => {
      if (font.size === fontSize) return;
      font = { ...font, size: fontSize };
      current.terminal.options.fontSize = fontSize;
      element.dataset["fontSize"] = String(fontSize);
      fit();
      drawHighlights();
      current.loop.redraw();
      fontLoaded(loadTerminalFont(font.family, font.size), ++fontVersion);
    },
    onData: (listener) => {
      dataListener = listener;
    },
    paste: (data) => current.terminal.paste(data),
    setKeyFilter: (filter) => {
      keyFilter = filter;
    },
    setLinks: (next) => {
      links = next;
    },
    findNext: (term, findOptions, incremental) =>
      search(term, findOptions, incremental === true ? "incremental" : "next"),
    findPrevious: (term, findOptions) => search(term, findOptions, "previous"),
    clearFind: () => {
      find = undefined;
      drawHighlights();
    },
    onFindResults: (listener) => {
      findListener = listener;
    },
    getSelection: () => current.terminal.getSelection(),
    dispose: () => {
      disposed = true;
      clearTimeout(mirrorTimer);
      if (refindFrame !== undefined) cancelAnimationFrame(refindFrame);
      close();
      highlights.remove();
      mirror.remove();
    },
  };
}
