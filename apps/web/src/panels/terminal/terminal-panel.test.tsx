// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Ghostty, Terminal } from "ghostty-web";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import type { Api } from "@/api/types";
import { installKeyboard, isMac, registerShortcut } from "@/keyboard/registry";
import { usePageTrustedLinks } from "@/links/trusted-links";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { themeStore } from "@/theme/store";

import { quietRenderLoop, type RenderLoop } from "./render-loop";
import { TerminalPanel } from "./terminal-panel";
import { resetTerminals } from "./terminals-store";

const fake = vi.hoisted(() => {
  class FakeTerminal {
    output = "";
    cols = 100;
    rows = 30;
    theme: unknown;
    focused = false;
    disposed = false;
    #listener: ((data: string) => void) | undefined;
    write(data: string) {
      this.output += data;
    }
    reset() {
      this.output = "";
    }
    focus() {
      this.focused = true;
    }
    fit() {}
    visible: boolean | undefined;
    setVisible(visible: boolean) {
      this.visible = visible;
    }
    setFont() {}
    resized: ((cols: number, rows: number) => void) | undefined;
    fontSize = 0;
    setFontSize(fontSize: number) {
      this.fontSize = fontSize;
    }
    onData(listener: (data: string) => void) {
      this.#listener = listener;
    }
    pasted: string[] = [];
    paste(data: string) {
      this.pasted.push(data);
    }
    setKeyFilter() {}
    finds: { term: string; direction: "next" | "previous"; incremental?: boolean | undefined }[] =
      [];
    findNext(term: string, _options: unknown, incremental?: boolean) {
      this.finds.push({ term, direction: "next", incremental });
      return true;
    }
    findPrevious(term: string) {
      this.finds.push({ term, direction: "previous" });
      return true;
    }
    cleared = 0;
    clearFind() {
      this.cleared++;
    }
    #findListener: ((results: { index: number; count: number }) => void) | undefined;
    onFindResults(listener: (results: { index: number; count: number }) => void) {
      this.#findListener = listener;
    }
    results(index: number, count: number) {
      this.#findListener?.({ index, count });
    }
    selection = "";
    getSelection() {
      return this.selection;
    }
    links:
      | {
          onUrl(url: string): void;
          findPaths(
            text: string,
          ): readonly { start: number; end: number; path: string; line: number }[];
          onPath(link: { start: number; end: number; path: string; line: number }): void;
        }
      | undefined;
    setLinks(links: FakeTerminal["links"]) {
      this.links = links;
    }
    dispose() {
      this.disposed = true;
    }
    type(data: string) {
      this.#listener?.(data);
    }
  }
  const terminals: FakeTerminal[] = [];
  return {
    terminals,
    createTerminal: async (
      _element: HTMLElement,
      options: { theme: unknown; onResize?: (cols: number, rows: number) => void },
    ) => {
      const terminal = new FakeTerminal();
      terminal.theme = options.theme;
      terminal.resized = options.onResize;
      terminals.push(terminal);
      return terminal;
    },
  };
});

vi.mock("./ghostty-loader", () => ({ createTerminal: fake.createTerminal }));

const THREAD = "t-flaky" as ThreadId;

afterEach(() => {
  cleanup();
  resetTerminals();
  fake.terminals.length = 0;
  useThreadsStore.setState({ byId: {} });
  useServerSettings.setState({ settings: undefined });
});

/** Feeds the mock's first `threads.snapshot` into the threads store, as the app shell does. */
const seedThreads = async (api: MockApi) => {
  const abort = new AbortController();
  const events = api.events(abort.signal)[Symbol.asyncIterator]();
  const first = await events.next();
  if (!first.done) useThreadsStore.getState().applyEvent(first.value);
  abort.abort();
};

const live = () => fake.terminals.filter((t) => !t.disposed);

describe("TerminalPanel", () => {
  it("opens a terminal for the thread, writes the replay and echoes typed input", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const resize = vi.spyOn(api, "terminalResize");
    renderWithApi(<TerminalPanel threadId={THREAD} />, api);

    await waitFor(() => expect(live()[0]?.output).toContain("$ "));
    expect(live()[0]?.output).toContain("/Users/dev/code/api/.worktrees/fix-flaky-retry");
    expect(live()[0]?.theme).toMatchObject({ background: expect.stringMatching(/^#/) });

    live()[0]!.type("ls\r");
    await waitFor(() => expect(live()[0]?.output).toContain("echo: ls"));
    expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(resize).not.toHaveBeenCalledWith(expect.anything(), 0, 0);
  });

  it("sends the changed grid to the PTY when fonts settle without a container resize", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const resize = vi.spyOn(api, "terminalResize");
    renderWithApi(<TerminalPanel threadId={THREAD} />, api);
    await waitFor(() => expect(live()[0]?.output).toContain("$ "));
    const surface = screen.getByTestId("terminal-surface");
    Object.defineProperties(surface, {
      clientWidth: { value: 480 },
      clientHeight: { value: 360 },
    });
    resize.mockClear();
    act(() => live()[0]!.resized?.(84, 42));
    expect(resize).toHaveBeenCalledWith(expect.anything(), 84, 42);
    const removed = live()[0]!;
    cleanup();
    resize.mockClear();
    removed.resized?.(80, 40);
    expect(resize).not.toHaveBeenCalled();
  });

  it("withholds hidden and zero-geometry grids, synchronizes on activation and deduplicates fit callbacks", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const resize = vi.spyOn(api, "terminalResize");
    renderWithApi(<TerminalPanel threadId={THREAD} />, api);
    await waitFor(() => expect(live()[0]?.output).toContain("$ "));
    const first = live()[0]!;
    const surface = screen.getByTestId("terminal-surface");
    let width = 480;
    let height = 360;
    Object.defineProperties(surface, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
    });
    act(() => first.resized?.(100, 30));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(live()[1]?.output).toContain("$ "));
    first.cols = 84;
    first.rows = 42;
    resize.mockClear();
    act(() => first.resized?.(84, 42));
    expect(resize).not.toHaveBeenCalled();
    const fit = vi.spyOn(first, "fit").mockImplementation(() => first.resized?.(84, 42));
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 1" }));
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(expect.anything(), 84, 42);

    resize.mockClear();
    act(() => first.resized?.(84, 42));
    expect(resize).not.toHaveBeenCalled();
    width = 0;
    act(() => first.resized?.(80, 40));
    width = 480;
    height = 0;
    act(() => first.resized?.(80, 40));
    height = 360;
    surface.style.visibility = "hidden";
    act(() => first.resized?.(80, 40));
    expect(resize).not.toHaveBeenCalled();
    surface.style.visibility = "visible";
    act(() => first.resized?.(80, 40));
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("remakes the terminal in a new theme and replays into it, since the emulator can't be recoloured", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const mode = themeStore.getState().mode;
    try {
      themeStore.setState({ mode: "dark" });
      renderWithApi(<TerminalPanel threadId={THREAD} />, api);
      await waitFor(() => expect(live()[0]?.output).toContain("$ "));
      const first = live()[0]!;
      first.type("ls\r");
      await waitFor(() => expect(first.output).toContain("echo: ls"));

      act(() => themeStore.setState({ mode: "light" }));
      await waitFor(() => expect(first.disposed).toBe(true));
      await waitFor(() => expect(live()[0]?.output).toContain("echo: ls"));
      expect(live()).toHaveLength(1);
      expect(live()[0]?.theme).not.toEqual(first.theme);
    } finally {
      themeStore.setState({ mode });
    }
  });

  it("adds terminals in tabs and restarts an exited shell", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    renderWithApi(<TerminalPanel threadId={THREAD} />, api);
    await waitFor(() => expect(live()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getByRole("tab", { name: "Terminal 2" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await waitFor(() => expect(live()[1]?.output).toContain("$ "));

    live()[1]!.type("exit\r");
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(live()).toHaveLength(2));
    await waitFor(async () =>
      expect((await api.terminalList(THREAD)).filter((t) => t.alive)).toHaveLength(2),
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("types dropped files' real paths, quoted for the shell", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    Object.defineProperty(window, "gram", {
      value: { getPathForFile: (file: File) => `/Users/me/my repo/${file.name}` },
      configurable: true,
    });
    try {
      renderWithApi(<TerminalPanel threadId={THREAD} />, api);
      await waitFor(() => expect(live()[0]?.output).toContain("$ "));
      const files = [new File(["x"], "it's & $x.txt"), new File(["y"], "plain.txt")];
      fireEvent.drop(screen.getByTestId("terminal-surface"), {
        dataTransfer: { files, types: ["Files"] },
      });
      expect(live()[0]?.pasted).toEqual([
        "'/Users/me/my repo/it'\\''s & $x.txt' '/Users/me/my repo/plain.txt' ",
      ]);
    } finally {
      Reflect.deleteProperty(window, "gram");
    }
  });

  it("opens URLs externally and checkout path:line links in the editor, only on click", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const openExternal = vi.spyOn(api, "openExternal");
    const openInEditor = vi.spyOn(api, "openInEditor");
    await seedThreads(api);
    renderWithApi(<TerminalPanel threadId={THREAD} />, api);
    await waitFor(() => expect(live()[0]?.links).toBeDefined());
    const links = live()[0]!.links!;
    expect(openExternal).not.toHaveBeenCalled();

    // In a browser the page asks first, so an untrusted host waits for an answer.
    links.onUrl("https://example.test/docs");
    await Promise.resolve();
    expect(openExternal).not.toHaveBeenCalled();
    usePageTrustedLinks.getState().add("example.test");
    links.onUrl("https://example.test/docs");
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://example.test/docs"));
    usePageTrustedLinks.getState().remove("example.test");

    const [link] = links.findPaths("error at src/retry.ts:12:3");
    expect(link).toMatchObject({ path: expect.stringMatching(/\/src\/retry\.ts$/), line: 12 });
    expect(links.findPaths("see /etc/hosts.conf:1")).toEqual([]);
    links.onPath(link!);
    await waitFor(() =>
      expect(openInEditor).toHaveBeenCalledWith(link!.path, { line: 12, threadId: THREAD }),
    );
  });

  it("zooms the focused terminal's font with ⌘= / ⌘- / ⌘0 and saves fonts.monoSize", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const updateSettings = vi.spyOn(api, "updateSettings");
    const uninstall = installKeyboard();
    // `mod` is ⌘ on macOS and Ctrl elsewhere, whatever the test environment reports.
    const mod = isMac() ? { metaKey: true, ctrlKey: false } : { metaKey: false, ctrlKey: true };
    try {
      renderWithApi(<TerminalPanel threadId={THREAD} />, api);
      await waitFor(() => expect(live()[0]?.output).toContain("$ "));
      const surface = screen.getByTestId("terminal-surface");
      const input = document.createElement("textarea");
      surface.appendChild(input);
      input.focus();
      const press = (key: string, code: string) => fireEvent.keyDown(input, { key, code, ...mod });

      press("=", "Equal");
      await waitFor(() =>
        expect(updateSettings).toHaveBeenLastCalledWith({ fonts: { monoSize: 13 } }),
      );
      await waitFor(() => expect(live()[0]?.fontSize).toBe(13));
      press("-", "Minus");
      await waitFor(() =>
        expect(updateSettings).toHaveBeenLastCalledWith({ fonts: { monoSize: 12 } }),
      );
      press("0", "Digit0");
      await waitFor(() =>
        expect(updateSettings).toHaveBeenLastCalledWith({ fonts: { monoSize: null } }),
      );

      input.blur();
      updateSettings.mockClear();
      fireEvent.keyDown(document.body, { key: "=", code: "Equal", ...mod });
      expect(updateSettings).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it("opens find with ⌘F only while the terminal has focus, steps, and Esc refocuses the shell", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const uninstall = installKeyboard();
    const mod = isMac() ? { metaKey: true, ctrlKey: false } : { metaKey: false, ctrlKey: true };
    const threadFind = vi.fn();
    const mode = themeStore.getState().mode;
    themeStore.setState({ mode: "dark" });
    try {
      renderWithApi(<TerminalPanel threadId={THREAD} />, api);
      await waitFor(() => expect(live()[0]?.output).toContain("$ "));
      // Registered after the terminal's, as a thread pane re-registers Find in thread on focus.
      const unregister = registerShortcut({
        id: "thread.find",
        keys: "mod+f",
        label: "Find in thread",
        group: "Thread",
        run: threadFind,
      });
      let term = live()[0]!;
      term.selection = "retry";
      const surface = screen.getByTestId("terminal-surface");
      const emulatorInput = document.createElement("textarea");
      surface.appendChild(emulatorInput);
      emulatorInput.focus();

      fireEvent.keyDown(emulatorInput, { key: "f", code: "KeyF", ...mod });
      const field = await screen.findByRole<HTMLInputElement>("textbox", {
        name: "Find in terminal",
      });
      expect(threadFind).not.toHaveBeenCalled();
      expect(field.value).toBe("retry");
      await waitFor(() => expect(document.activeElement).toBe(field));
      expect(term.finds.at(-1)).toEqual({ term: "retry", direction: "next", incremental: true });
      act(() => term.results(0, 3));
      expect(screen.getByTestId("terminal-find-status").textContent).toBe("1 of 3");

      // A new theme is a new emulator, which knows nothing of the find the bar still shows.
      act(() => themeStore.setState({ mode: "light" }));
      await waitFor(() => expect(term.disposed).toBe(true));
      await waitFor(() =>
        expect(live()[0]?.finds.at(-1)).toEqual({
          term: "retry",
          direction: "next",
          incremental: true,
        }),
      );
      term = live()[0]!;

      fireEvent.keyDown(field, { key: "Enter", code: "Enter", shiftKey: true });
      expect(term.finds.at(-1)).toMatchObject({ term: "retry", direction: "previous" });
      fireEvent.keyDown(field, { key: "g", code: "KeyG", ...mod });
      expect(term.finds.at(-1)).toEqual({ term: "retry", direction: "next", incremental: false });

      term.focused = false;
      fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
      expect(screen.queryByTestId("terminal-find-bar")).toBeNull();
      expect(term.cleared).toBeGreaterThan(0);
      expect(term.focused).toBe(true);

      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: "f", code: "KeyF", ...mod });
      expect(threadFind).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("terminal-find-bar")).toBeNull();
      unregister();
    } finally {
      uninstall();
      themeStore.setState({ mode });
    }
  });

  it("offers a new shell when the server no longer has the terminal, as after a restart", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const gone = Object.assign(new Error("terminal"), { _tag: "NotFound" });
    const feed = vi.spyOn(api, "terminalFeed").mockImplementationOnce(async function* () {
      yield* [];
      throw gone;
    });
    renderWithApi(<TerminalPanel threadId={THREAD} />, api);

    expect(await screen.findByText("This terminal ended with the server")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    feed.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(live()).toHaveLength(1));
    await waitFor(() => expect(live()[0]?.output).toContain("$ "));
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("explains when the server has no terminal yet", async () => {
    const notImplemented = Object.assign(new Error("terminal.list"), { _tag: "NotImplemented" });
    renderWithApi(<TerminalPanel threadId={THREAD} />, {
      terminalList: vi.fn(async () => {
        throw notImplemented;
      }),
    } satisfies Partial<Api>);
    expect(
      await screen.findByText("The terminal isn't available on this server yet."),
    ).toBeTruthy();
  });
});

// The real ghostty-web, drawing into a canvas that only counts, with frames run by hand: what its
// render loop does is the point, and a bump that renames what `render-loop.ts` reaches into fails
// here rather than quietly drawing every frame again.
describe("quietRenderLoop", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let draws = 0;
  let fading = 0;
  const opened: Terminal[] = [];

  /** `clock` fakes `Date` too, which the scrollbar's fades run on. */
  const open = async (clock = false) => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", ...(clock ? (["Date"] as const) : [])],
    });
    const context = new Proxy(
      {},
      {
        get: (_, key) =>
          key === "measureText"
            ? () => ({ width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 })
            : key === "fillRect" || key === "fillText"
              ? () => void draws++
              : () => {},
        set: (_, key, value) => {
          // ghostty-web paints its scrollbar's track, and nothing else, in this grey, at a tenth of
          // its opacity: below that is a step of a fade.
          const track = /^rgba\(128, 128, 128, ([\d.]+)\)$/.exec(String(value));
          if (key === "fillStyle" && track && Number(track[1]) < 0.099) fading++;
          return true;
        },
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const wasm = await readFile(
      createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm"),
    );
    const instance = new WebAssembly.Instance(await WebAssembly.compile(wasm), {
      env: { log: () => {} },
    });
    const terminal = new Terminal({ ghostty: new Ghostty(instance), cursorBlink: true });
    const host = document.createElement("div");
    document.body.append(host);
    terminal.open(host);
    opened.push(terminal);
    const loop = quietRenderLoop(terminal, true);
    await settle(loop);
    return { terminal, loop };
  };

  /** Runs one animation frame, then the microtasks after it; the canvas draws it made. */
  const frame = async () => {
    const before = draws;
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(performance.now());
    await Promise.resolve();
    return draws - before;
  };
  /** Runs frames until the loop sleeps; what they drew in all. */
  const settle = async (loop: RenderLoop) => {
    let drawn = 0;
    for (let i = 0; i < 10 && !loop.asleep; i++) drawn += await frame();
    expect(loop.asleep).toBe(true);
    return drawn;
  };

  afterEach(() => {
    for (const terminal of opened.splice(0)) terminal.dispose();
    frames.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stops drawing, and stops asking for frames, once nothing changes", async () => {
    const { loop } = await open();
    loop.wake();
    expect(await settle(loop)).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("draws output, the blink, a selection and a hovered link at the next frame", async () => {
    const { terminal, loop } = await open();

    terminal.write("$ ls");
    loop.wake();
    expect(await frame()).toBeGreaterThan(0);
    await settle(loop);

    vi.advanceTimersByTime(530);
    expect(frames.size).toBe(1);
    expect(await settle(loop)).toBeGreaterThan(0);

    terminal.selectAll();
    expect(await settle(loop)).toBeGreaterThan(0);

    terminal.renderer!.setHoveredLinkRange({ startX: 2, startY: 0, endX: 3, endY: 0 });
    expect(await settle(loop)).toBeGreaterThan(0);
  });

  it("repaints unchanged rows after a font load, including while hidden", async () => {
    const { terminal, loop } = await open();
    terminal.write("font-loaded-output");
    loop.wake();
    await settle(loop);
    loop.redraw();
    expect(await settle(loop)).toBeGreaterThan(0);
    loop.setVisible(false);
    loop.redraw();
    expect(await settle(loop)).toBe(0);
    loop.setVisible(true);
    expect(await settle(loop)).toBeGreaterThan(0);
  });

  it("draws a resize and a font change on the spot, without the loop", async () => {
    const { terminal, loop } = await open();
    let before = draws;
    terminal.resize(40, 10);
    expect(draws).toBeGreaterThan(before);

    before = draws;
    terminal.options.fontSize = 20;
    expect(draws).toBeGreaterThan(before);
    expect(loop.asleep).toBe(true);
  });

  it("follows a scroll into the scrollback, and fades its scrollbar out asleep", async () => {
    const { terminal, loop } = await open(true);
    terminal.write(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n"));
    loop.wake();
    await settle(loop);

    // The scrollbar's fade-in may draw the scrolled screen itself, on the spot and timed by the
    // clock, so what counts is that the scroll wakes the loop and the screen gets drawn at all.
    const before = draws;
    terminal.scrollToTop();
    expect(loop.asleep).toBe(false);
    await settle(loop);
    expect(draws).toBeGreaterThan(before);

    // Both fades run off their own timers and frames and draw each step themselves, so they need
    // nothing from the loop, asleep through the fade-out.
    for (let i = 0; i < 20 && frames.size > 0; i++) {
      vi.advanceTimersByTime(20);
      await frame();
    }
    expect(loop.asleep).toBe(true);
    const shown = fading;
    // What its 1.5 s timeout calls; the timeout is happy-dom's own, which fake timers don't reach.
    (terminal as unknown as { hideScrollbar(): void }).hideScrollbar();
    for (let i = 0; i < 20 && frames.size > 0; i++) {
      vi.advanceTimersByTime(20);
      await frame();
    }
    expect(fading).toBeGreaterThan(shown);
    expect(frames.size).toBe(0);
    expect(loop.asleep).toBe(true);
  });

  it("draws nothing while hidden, and all of it once shown", async () => {
    const { terminal, loop } = await open();
    loop.setVisible(false);
    terminal.write("while hidden");
    loop.wake();
    vi.advanceTimersByTime(530);
    expect(frames.size).toBe(0);

    loop.setVisible(true);
    const lines = await settle(loop);
    terminal.write("x");
    loop.wake();
    expect(lines).toBeGreaterThan(await settle(loop));
  });
});
