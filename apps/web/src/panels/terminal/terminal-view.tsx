import type { TerminalId, ThreadId } from "@gram/contracts";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";

import { useApi } from "@/api/context";
import { isNotFound } from "@/api/errors";
import { openContentUrl } from "@/api/open-external";
import { Button } from "@/components/ui/button";
import { useOpenInEditor, useOpensLocally } from "@/editor/use-open-in-editor";
import { dispatchShortcut, useShortcut, useShortcutList } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { showFileAt } from "@/panels/files/files-store";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { useThemeStore } from "@/theme/store";

import { copyText } from "@/settings/copy-text";

import { isAppShortcut, terminalClipboardKey } from "./keys";
import { findPathLinks } from "./links";
import { formatDroppedPaths, shellKind } from "./shell-quote";
import {
  TerminalFindBar,
  type FindRequest,
  type FindToggles,
  type TerminalFind,
} from "./terminal-find-bar";
import { monoFont, useTerminalSearchColors, useTerminalTheme } from "./terminal-theme";
import { terminalProblem } from "./terminals-store";
import {
  createTerminal,
  type TerminalFindResults,
  type TerminalHandle,
  type TerminalTheme,
} from "./ghostty-loader";

const RESIZE_DEBOUNCE_MS = 80;
/** `fonts.monoSize` when unset. */
const DEFAULT_FONT_SIZE = 12;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

// Only the desktop app knows where a dropped file lives; a browser drop has no path to type.
const droppedPaths = (event: DragEvent) =>
  [...event.dataTransfer.files]
    .map((file) => window.gram?.getPathForFile(file))
    .filter((path): path is string => path !== undefined && path !== "");

const onDragOver = (event: DragEvent<HTMLDivElement>) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
};

/**
 * One emulator bound to a server terminal: replay + data are written, keystrokes sent as input, and
 * size changes sent (debounced) as resizes. Stays mounted while another tab is active so its
 * buffer survives; a later mount re-subscribes and gets the replay, and so does a change of theme,
 * which the emulator can only take when it is made. Dropped files type their paths, links open on
 * click, and ⌘= / ⌘- / ⌘0 zoom the monospace font while the terminal has focus.
 */
export function TerminalView({
  threadId,
  terminalId,
  shell,
  active,
  onRestart,
}: {
  threadId: ThreadId;
  terminalId: TerminalId;
  /** The running shell, for quoting dropped paths; POSIX rules when unknown. */
  shell?: string | undefined;
  active: boolean;
  onRestart: () => void;
}) {
  const api = useApi();
  const openInEditor = useOpenInEditor();
  // In managed mode a path opens in the Files panel: there is no editor to open it in.
  const local = useOpensLocally();
  const saveSettings = useSaveSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [finding, setFinding] = useState<FindRequest | null>(null);
  const [findResults, setFindResults] = useState<TerminalFindResults | undefined>();
  const [exit, setExit] = useState<{ code?: number; signal?: string; gone?: true } | null>(null);
  const [problem, setProblem] = useState<string | undefined>();
  const theme = useTerminalTheme();
  const searchColors = useTerminalSearchColors();
  // Re-render on a look switch so the font effect below picks up the new `--font-mono`.
  useThemeStore((s) => s.look);
  const shortcuts = useShortcutList();
  const monoSize = useServerSettings((s) => s.settings?.fonts.monoSize);
  const fontSize = monoSize ?? DEFAULT_FONT_SIZE;
  // Re-renders when the monospace setting changes, so the effect below picks up the new family.
  useServerSettings((s) => s.settings?.fonts.mono);
  const root = useThreadsStore((s) => s.byId[threadId]?.thread.checkout.path);

  // The theme by value: the hook makes a new object every render, and a new theme remakes the terminal.
  const themeKey = JSON.stringify(theme);

  /** The find last run, so a terminal remade for a new theme can take it over from the old one. */
  const lastFind = useRef<{ query: string; toggles: FindToggles } | null>(null);

  const latest = useRef({
    theme,
    searchColors,
    shortcuts,
    active,
    fontSize,
    root,
    openInEditor,
    local,
  });
  useEffect(() => {
    latest.current = {
      theme,
      searchColors,
      shortcuts,
      active,
      fontSize,
      root,
      openInEditor,
      local,
    };
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const abort = new AbortController();
    let handle: TerminalHandle | undefined;
    let observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let initialized = false;
    let sentGrid: { cols: number; rows: number } | undefined;
    const canResize = () =>
      !abort.signal.aborted &&
      initialized &&
      latest.current.active &&
      element.clientWidth > 0 &&
      element.clientHeight > 0 &&
      getComputedStyle(element).visibility !== "hidden";
    const sendGrid = (cols: number, rows: number) => {
      if (!canResize() || cols <= 0 || rows <= 0) return;
      if (sentGrid?.cols === cols && sentGrid.rows === rows) return;
      const grid = { cols, rows };
      sentGrid = grid;
      void api.terminalResize(terminalId, cols, rows).catch(() => {
        if (sentGrid === grid) sentGrid = undefined;
      });
    };

    void (async () => {
      try {
        handle = await createTerminal(element, {
          theme: JSON.parse(themeKey) as TerminalTheme,
          fontFamily: monoFont(),
          fontSize: latest.current.fontSize,
          onResize: sendGrid,
        });
      } catch (error) {
        if (!abort.signal.aborted) setProblem(terminalProblem(error));
        return;
      }
      if (abort.signal.aborted) {
        handle.dispose();
        return;
      }
      const term = handle;
      // Preferences may change while WASM or a cold font is loading.
      term.setFont(monoFont());
      term.setFontSize(latest.current.fontSize);
      handleRef.current = term;
      term.setKeyFilter((event) => {
        const clipboard = terminalClipboardKey(event);
        if (clipboard === "copy") {
          // Also keeps an app shortcut on the same chord from running.
          event.preventDefault();
          const selection = term.getSelection();
          if (selection !== "") void copyText(selection).catch(() => {});
          return false;
        }
        // The emulator lets the browser's paste through and keeps ^V from the shell on its own,
        // but only for a key it is still handling.
        if (clipboard === "paste") return true;
        if (!isAppShortcut(event, latest.current.shortcuts)) return true;
        dispatchShortcut(event);
        return false;
      });
      term.onFindResults((results) => {
        if (!abort.signal.aborted) setFindResults(results);
      });
      term.onData((data) => void api.terminalInput(terminalId, data).catch(() => {}));
      term.setLinks({
        onUrl: (url) => void openContentUrl(api, url).catch(() => {}),
        findPaths: (text) => findPathLinks(text, latest.current.root),
        onPath: (link) => {
          const { local: opensLocally, root: checkout } = latest.current;
          if (opensLocally || checkout === undefined) {
            void latest.current.openInEditor(link.path, { line: link.line, threadId });
          } else {
            showFileAt(threadId, [checkout], link.path, { line: link.line });
          }
        },
      });

      const sendSize = () => {
        if (!canResize()) return;
        term.fit();
        sendGrid(term.cols, term.rows);
      };
      resizeRef.current = sendSize;
      initialized = true;
      sendSize();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(sendSize, RESIZE_DEBOUNCE_MS);
        });
        observer.observe(element);
      }
      term.setVisible(latest.current.active);
      if (latest.current.active) term.focus();

      try {
        for await (const event of api.terminalFeed(terminalId, abort.signal)) {
          if (event.type === "replay") {
            term.reset();
            term.write(event.data);
            // The find bar only searches when its query changes, and this may be a new emulator.
            const open = lastFind.current;
            if (open !== null) {
              term.findNext(
                open.query,
                { ...open.toggles, colors: latest.current.searchColors },
                true,
              );
            }
          } else if (event.type === "data") {
            term.write(event.data);
          } else {
            setExit({
              ...(event.code !== undefined ? { code: event.code } : {}),
              ...(event.signal !== undefined ? { signal: event.signal } : {}),
            });
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        // The server no longer has it, as after a restart: its shell is gone, so offer a new one.
        if (isNotFound(error)) setExit({ gone: true });
        else setProblem(terminalProblem(error));
      }
    })();

    return () => {
      abort.abort();
      clearTimeout(timer);
      observer?.disconnect();
      handle?.dispose();
      handleRef.current = null;
      resizeRef.current = null;
    };
  }, [api, terminalId, threadId, themeKey]);

  useEffect(() => {
    handleRef.current?.setFont(monoFont());
  });

  useEffect(() => {
    handleRef.current?.setFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    handleRef.current?.setVisible(active);
    if (active) {
      // A hidden terminal may have loaded a font without notifying its PTY.
      resizeRef.current?.();
      handleRef.current?.focus();
    }
  }, [active]);

  // Zoom only while this terminal is the active tab and has focus; app shortcuts keep working.
  const focused = () =>
    latest.current.active && containerRef.current?.contains(document.activeElement) === true;
  const zoom = (size: number | null) =>
    void saveSettings({
      fonts: {
        monoSize: size === null ? null : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)),
      },
    }).catch(() => {});
  useShortcut({
    id: "terminal.zoomIn",
    keys: "mod+=",
    label: "Zoom in terminal",
    group: "Terminal",
    when: focused,
    run: () => zoom(latest.current.fontSize + 1),
  });
  useShortcut({
    id: "terminal.zoomOut",
    keys: "mod+-",
    label: "Zoom out terminal",
    group: "Terminal",
    when: focused,
    run: () => zoom(latest.current.fontSize - 1),
  });
  useShortcut({
    id: "terminal.zoomReset",
    keys: "mod+0",
    label: "Reset terminal zoom",
    group: "Terminal",
    when: focused,
    run: () => zoom(null),
  });

  // Scoped to the whole terminal, bar included, so ⌘F reaches it over Find in thread.
  const inTerminal = () =>
    latest.current.active && rootRef.current?.contains(document.activeElement) === true;
  useShortcut({
    id: "terminal.find",
    keys: "mod+f",
    label: "Find in terminal",
    group: "Terminal",
    focusScope: inTerminal,
    run: () => {
      const selection = handleRef.current?.getSelection() ?? "";
      setFinding((open) => ({
        nonce: (open?.nonce ?? 0) + 1,
        seed: selection.includes("\n") ? "" : selection,
      }));
    },
  });
  const find: TerminalFind = {
    next: (query, toggles, incremental) => {
      lastFind.current = { query, toggles };
      handleRef.current?.findNext(
        query,
        { ...toggles, colors: latest.current.searchColors },
        incremental,
      );
    },
    previous: (query, toggles) => {
      lastFind.current = { query, toggles };
      handleRef.current?.findPrevious(query, { ...toggles, colors: latest.current.searchColors });
    },
    clear: () => {
      lastFind.current = null;
      handleRef.current?.clearFind();
      setFindResults(undefined);
    },
  };
  const closeFind = () => {
    find.clear();
    setFinding(null);
    handleRef.current?.focus();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const paths = droppedPaths(event);
    if (paths.length === 0) return;
    event.preventDefault();
    handleRef.current?.paste(formatDroppedPaths(paths, shellKind(shell ?? "/bin/sh")));
    handleRef.current?.focus();
  };

  const exitDetail =
    exit?.code !== undefined ? ` with code ${exit.code}` : exit?.signal ? ` (${exit.signal})` : "";

  return (
    <div
      ref={rootRef}
      data-testid="terminal"
      data-terminal-id={terminalId}
      aria-hidden={!active}
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
    >
      <div
        ref={containerRef}
        data-testid="terminal-surface"
        onDragOver={onDragOver}
        onDrop={onDrop}
        className="min-h-0 flex-1 overflow-hidden p-1.5"
        style={{ backgroundColor: theme.background }}
      />
      {finding && (
        <TerminalFindBar
          find={find}
          results={findResults}
          request={finding}
          inScope={inTerminal}
          onClose={closeFind}
        />
      )}
      {exit && (
        <div
          role="status"
          className="flex items-center gap-2 border-t border-border px-2 py-1.5 text-xs text-muted-foreground"
        >
          {exit.gone ? "This terminal ended with the server" : `Process exited${exitDetail}`}
          <Button type="button" size="xs" variant="outline" className="ml-auto" onClick={onRestart}>
            <RotateCcw data-icon="inline-start" />
            Restart
          </Button>
        </div>
      )}
      {problem && (
        <p role="alert" className="border-t border-border px-2 py-1.5 text-xs text-danger-text">
          {problem}
        </p>
      )}
    </div>
  );
}
