import type { DesktopPages, PageBounds, PageViewState } from "@gram/contracts";

/**
 * The shell's pinned pages for the mock API: a sandboxed iframe per page, fixed over the window at
 * the bounds the tab sends, as the shell's native view is. It shows a synthetic page naming the
 * address it was asked for, and keeps what it opened in `opened`, as `key url`, for specs.
 */
export class MockPages implements DesktopPages {
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  readonly #frames = new Map<string, HTMLIFrameElement>();
  readonly #listeners = new Set<{ key: string; callback: (state: PageViewState) => void }>();

  #emit(key: string, state: PageViewState) {
    for (const listener of this.#listeners) if (listener.key === key) listener.callback(state);
  }

  async open(key: string, url: string): Promise<boolean> {
    // As the shell: a page listener address only.
    if (!/^http:\/\/127\.0\.0\.1:\d+\/gram-pages\/[A-Za-z0-9_-]+\//.test(url)) return false;
    this.opened.push(`${key} ${url}`);
    let frame = this.#frames.get(key);
    if (frame === undefined) {
      frame = document.createElement("iframe");
      frame.dataset["testid"] = "mock-page-view";
      frame.dataset["page"] = key;
      frame.title = "Pinned page";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.style.cssText =
        "position: fixed; border: 0; z-index: 2147483000; background: white; display: none;";
      document.body.append(frame);
      this.#frames.set(key, frame);
    }
    frame.dataset["url"] = url;
    frame.srcdoc = `<!doctype html><body style="font: 14px system-ui; margin: 16px"><p>A pinned page</p><p style="color: #666">${url.replace(/[<>&"]/g, "")}</p></body>`;
    this.#emit(key, { loading: false });
    return true;
  }

  setBounds(key: string, bounds: PageBounds | null): void {
    const frame = this.#frames.get(key);
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

  reload(key: string): void {
    this.#emit(key, { loading: false });
  }

  close(key: string): void {
    this.closed.push(key);
    this.#frames.get(key)?.remove();
    this.#frames.delete(key);
  }

  onState(key: string, callback: (state: PageViewState) => void): () => void {
    const listener = { key, callback };
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
