/**
 * The only door to ghostty-web's render loop. As of 0.4.0 every terminal runs one for as long as it
 * lives: each animation frame it calls `renderer.render`, seen or not, changed or not, and `render`
 * draws the cursor every time, and the whole of the cursor's row while it blinks. A canvas drawn on
 * is a GPU upload and a composited frame, so a terminal sitting at a prompt cost the app a quarter of
 * a core on a 120 Hz display. The loop's wakeups alone, drawing nothing, still cost about 5%.
 *
 * So `render` is intercepted by name, as its loop calls it: a frame is drawn only when something it
 * shows has changed (a row the emulator marks dirty, the cursor or its blink, the viewport, the
 * scrollbar's fade, the link under the pointer, the selection), and after a frame with nothing to
 * draw the loop is stopped until one of those changes. That takes four private members: the blink
 * phase, the selection's request for a frame, the loop's frame id and its start. Were any renamed,
 * every frame would be drawn, or the loop run, as before, and nothing else would change;
 * `terminal-panel.test.tsx` runs the real package so that a bump which renames one fails there.
 */
import type { IRenderable, Terminal } from "ghostty-web";

/** What a terminal frame shows besides its rows, for telling whether a frame would change anything. */
interface FrameState {
  cursorX: number;
  cursorY: number;
  /** Shown by the program, and in the lit half of its blink. */
  cursorShown: boolean;
  /** Lines scrolled up from the bottom, fractional while a scroll animates. */
  viewportY: number;
  scrollbarOpacity: number;
}

/** Whether a frame after `drawn` would draw anything: its state differs, or a row is dirty. */
function frameChanged(
  drawn: FrameState | undefined,
  next: FrameState,
  buffer: Pick<IRenderable, "getDimensions" | "isRowDirty">,
): boolean {
  if (
    drawn === undefined ||
    drawn.cursorX !== next.cursorX ||
    drawn.cursorY !== next.cursorY ||
    drawn.cursorShown !== next.cursorShown ||
    drawn.viewportY !== next.viewportY ||
    drawn.scrollbarOpacity !== next.scrollbarOpacity
  ) {
    return true;
  }
  const { rows } = buffer.getDimensions();
  for (let y = 0; y < rows; y++) if (buffer.isRowDirty(y)) return true;
  return false;
}

export interface RenderLoop {
  /** One that can't be seen isn't drawn; the first frame once it can repaints it all. */
  setVisible(visible: boolean): void;
  /** Output was written: its frame is drawn on the next animation frame. */
  wake(): void;
  /** Font metrics or other drawing state changed: repaint even when no row is dirty. */
  redraw(): void;
  /** Whether it is waiting for a change, with no animation frame asked for. */
  readonly asleep: boolean;
  dispose(): void;
}

interface TerminalInternals {
  animationFrameId?: unknown;
  startRenderLoop?: unknown;
  selectionManager?: { requestRender?: unknown };
}

/** Takes over `terminal`'s render loop; call it once, right after `open`. */
export function quietRenderLoop(terminal: Terminal, visible: boolean): RenderLoop {
  const renderer = terminal.renderer!;
  const internals = terminal as unknown as TerminalInternals;
  const phase = renderer as unknown as { cursorVisible?: unknown };
  const selection = internals.selectionManager;
  const requestRender = selection?.requestRender;
  const start = internals.startRenderLoop;
  const gated = typeof phase.cursorVisible === "boolean" && typeof requestRender === "function";
  const sleeps =
    gated && typeof start === "function" && typeof internals.animationFrameId === "number";

  let redrawAll = false;
  /** The selection or the hovered link changed, which no dirty row records. */
  let asked = true;
  let drawn: FrameState | undefined;
  let running = true;
  let stopping = false;
  let restart: number | undefined;
  let disposed = false;

  const wake = () => {
    if (!visible) return;
    stopping = false;
    if (running || disposed || restart !== undefined) return;
    restart = requestAnimationFrame(() => {
      restart = undefined;
      if (running || disposed) return;
      running = true;
      (start as () => void).call(terminal);
    });
  };
  const ask = () => {
    asked = true;
    wake();
  };
  const sleep = () => {
    if (!sleeps || !running || stopping) return;
    stopping = true;
    // The loop asks for its next frame after `render` returns, and this runs once it has.
    queueMicrotask(() => {
      if (!stopping) return;
      stopping = false;
      cancelAnimationFrame(internals.animationFrameId as number);
      running = false;
    });
  };

  if (typeof requestRender === "function") {
    selection!.requestRender = (...args: unknown[]) => {
      ask();
      return requestRender.apply(selection, args);
    };
  }
  const hoverLink = renderer.setHoveredHyperlinkId.bind(renderer);
  renderer.setHoveredHyperlinkId = (id) => {
    ask();
    hoverLink(id);
  };
  const hoverRange = renderer.setHoveredLinkRange.bind(renderer);
  renderer.setHoveredLinkRange = (range) => {
    ask();
    hoverRange(range);
  };
  // The blink is a timer flipping this flag; the flip is what has to wake the loop.
  if (gated) {
    let lit = phase.cursorVisible as boolean;
    Object.defineProperty(renderer, "cursorVisible", {
      configurable: true,
      enumerable: true,
      get: () => lit,
      set: (next: boolean) => {
        if (next === lit) return;
        lit = next;
        wake();
      },
    });
  }
  terminal.onScroll(wake);

  const draw = renderer.render.bind(renderer);
  renderer.render = (buffer, forceAll, viewportY, scrollback, scrollbarOpacity) => {
    if (!visible) {
      sleep();
      return;
    }
    const force = forceAll === true || redrawAll;
    const cursor = buffer.getCursor();
    const frame: FrameState = {
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorShown: cursor.visible && phase.cursorVisible !== false,
      viewportY: viewportY ?? 0,
      scrollbarOpacity: scrollbarOpacity ?? 1,
    };
    if (gated && !force && !asked && !frameChanged(drawn, frame, buffer)) {
      sleep();
      return;
    }
    draw(buffer, force, viewportY, scrollback, scrollbarOpacity);
    redrawAll = false;
    asked = false;
    drawn = frame;
  };

  return {
    setVisible: (next) => {
      const was = visible;
      visible = next;
      if (next && !was) {
        redrawAll = true;
        wake();
      }
    },
    wake,
    redraw: () => {
      redrawAll = true;
      wake();
    },
    get asleep() {
      return !running && restart === undefined;
    },
    dispose: () => {
      disposed = true;
      if (restart !== undefined) cancelAnimationFrame(restart);
    },
  };
}
