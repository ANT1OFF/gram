import type { IRenderable, Terminal } from "ghostty-web";

interface FrameState {
  cursorX: number;
  cursorY: number;
  cursorShown: boolean;
  viewportY: number;
  scrollbarOpacity: number;
}

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
      const rendered: unknown = requestRender.apply(selection, args);
      return rendered;
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
