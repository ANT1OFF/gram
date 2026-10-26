import {
  loopbackUrl,
  type DesktopPreview,
  type BrowserInspection,
  type BrowserRegion,
  type BrowserViewportPreset,
  type PaneResult,
  type PreviewBounds,
  type PreviewState,
} from "@gram/contracts";

interface MockPage {
  readonly frame: HTMLIFrameElement;
  state: PreviewState;
}

/**
 * The shell's preview for the mock API: an iframe per thread, fixed over the window at the bounds
 * the page sends and above everything else, as the shell's native view is, so a spec sees the page
 * where the user would, and sees it cover a popup if the tab forgot to hide it. What it was asked to
 * open is kept in `opened` for specs, as `threadId url`.
 */
export class MockPreview implements DesktopPreview {
  readonly opened: string[] = [];
  /** The threads whose page the user handed back to its agent, in order. */
  readonly handedBack: string[] = [];
  readonly #pages = new Map<string, MockPage>();
  readonly #listeners = new Set<{ threadId: string; callback: (state: PreviewState) => void }>();

  #emit(threadId: string, patch: Partial<PreviewState>) {
    const page = this.#pages.get(threadId);
    if (page === undefined) return;
    page.state = { ...page.state, ...patch };
    for (const listener of this.#listeners) {
      if (listener.threadId === threadId) listener.callback(page.state);
    }
  }

  async open(threadId: string, url: string): Promise<boolean> {
    const target = loopbackUrl(url);
    if (target === undefined) return false;
    this.opened.push(`${threadId} ${target}`);
    let page = this.#pages.get(threadId);
    if (page === undefined) {
      const frame = document.createElement("iframe");
      frame.dataset["testid"] = "mock-preview-view";
      frame.dataset["thread"] = threadId;
      frame.title = "Preview";
      frame.style.cssText =
        "position: fixed; border: 0; z-index: 2147483000; background: white; display: none;";
      document.body.append(frame);
      page = { frame, state: emptyState(target) };
      this.#pages.set(threadId, page);
    }
    const { frame } = page;
    // Another fragment of the page it shows is a same-document navigation, with no load to wait for.
    const sameDocument =
      page.state.url !== target && page.state.url.split("#")[0] === target.split("#")[0];
    if (sameDocument) {
      frame.src = target;
      this.#emit(threadId, { url: target, loading: false });
      return true;
    }
    this.#emit(threadId, { ...emptyState(target), loading: true });
    await new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
      frame.src = target;
    });
    this.#emit(threadId, { loading: false, title: new URL(target).host });
    return true;
  }

  setBounds(threadId: string, bounds: PreviewBounds | null): void {
    const frame = this.#pages.get(threadId)?.frame;
    if (frame === undefined) return;
    if (bounds === null) {
      frame.style.display = "none";
      return;
    }
    Object.assign(frame.style, {
      display: "block",
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
  }

  // A cross-origin frame's history is out of the page's reach, so the mock has none.
  back(): void {}

  forward(): void {}

  reload(threadId: string): void {
    const page = this.#pages.get(threadId);
    if (page === undefined) return;
    this.#emit(threadId, { loading: true });
    page.frame.addEventListener("load", () => this.#emit(threadId, { loading: false }), {
      once: true,
    });
    page.frame.src = page.state.url;
  }

  /** E2e hook: replay explicit driver observations; the mock itself claims no inspection support. */
  observeInspection(threadId: string, browserInspection: BrowserInspection | undefined): void {
    this.#emit(threadId, { browserInspection });
  }

  /** Dev and e2e hook: who drives `threadId`'s page, as the shell reports it. */
  drive(threadId: string, driver: "agent" | "user"): void {
    this.#emit(threadId, { driver });
  }

  /** Dev and e2e hook: the agent's latest labelled input, and whether it records the page. */
  act(threadId: string, summary: string | undefined, recording = false): void {
    this.#emit(threadId, {
      action: summary === undefined ? undefined : { summary, at: Date.now() },
      recording,
    });
  }

  handBack(threadId: string): void {
    this.handedBack.push(threadId);
    this.#emit(threadId, { driver: "agent" });
  }

  takeOver(threadId: string): void {
    this.drive(threadId, "user");
  }

  // Explicit test replays may replace these methods. The iframe mock has no CDP inspection.
  async inspect(
    _threadId: string,
    _target?: { ref?: string; region?: BrowserRegion },
  ): Promise<PaneResult> {
    return {
      ok: false,
      code: "noPane",
      message: "The mock has no attached browser inspection driver.",
    };
  }
  async viewport(_threadId: string, _preset: BrowserViewportPreset): Promise<PaneResult> {
    return {
      ok: false,
      code: "noPane",
      message: "The mock has no attached browser inspection driver.",
    };
  }

  async state(threadId: string): Promise<PreviewState | null> {
    return this.#pages.get(threadId)?.state ?? null;
  }

  onState(threadId: string, callback: (state: PreviewState) => void): () => void {
    const listener = { threadId, callback };
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

const emptyState = (url: string): PreviewState => ({
  url,
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
});
