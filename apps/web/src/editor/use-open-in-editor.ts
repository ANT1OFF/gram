import type { ThreadId } from "@gram/contracts";

import { useApi } from "@/api/context";
import { errorMessage, isNotImplemented } from "@/api/errors";
import { isMac } from "@/keyboard/registry";
import { useFeature } from "@/settings/use-diagnostics";
import { useThreadsStore } from "@/stores/threads";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const notify = (kind: "info" | "error", title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind, title, body });

/** Whether local editor and file-manager actions are offered by runtime policy. */
export function useOpensLocally(): boolean {
  return useFeature("openInEditor");
}

/** Opens a file (optionally at a line) or folder in the configured editor, with a toast either way. */
export function useOpenInEditor() {
  const api = useApi();
  return async (path: string, options: { line?: number; threadId?: ThreadId } = {}) => {
    try {
      const { editor } = await api.openInEditor(path, options);
      notify("info", `Opening in ${editor}`, baseName(path));
    } catch (error) {
      notify(
        "error",
        "Couldn't open the editor",
        isNotImplemented(error)
          ? "Opening files in an editor isn't available yet."
          : errorMessage(error),
      );
    }
  };
}

/** "Finder" on macOS, "Explorer" on Windows, else "file manager". */
function fileManagerName(): string {
  const platform = window.gram?.platform;
  if (platform === undefined ? isMac() : platform === "darwin") return "Finder";
  if (platform === undefined ? /Win/.test(navigator.platform) : platform === "win32") {
    return "Explorer";
  }
  return "file manager";
}

/** "Reveal in Finder", "Show src/a.ts in Explorer", … */
export function revealLabel(subject?: string): string {
  const name = fileManagerName();
  const verb = name === "Finder" ? "Reveal" : "Show";
  return subject ? `${verb} ${subject} in ${name}` : `${verb} in ${name}`;
}

/**
 * Shows an absolute path selected in Finder / Explorer: through the desktop shell when it has
 * `showItemInFolder`, else the server (`threadId` scopes the path). Toasts either way.
 */
export function useRevealInFileManager() {
  const api = useApi();
  return async (path: string, options: { threadId?: ThreadId } = {}) => {
    const bridge = window.gram;
    try {
      if (bridge?.showItemInFolder) {
        if (!(await bridge.showItemInFolder(path))) throw new Error(`Not found: ${path}`);
        notify("info", `Showing in ${fileManagerName()}`, baseName(path));
        return;
      }
      const { manager } = await api.revealPath(path, options);
      notify("info", `Showing in ${manager}`, baseName(path));
    } catch (error) {
      notify(
        "error",
        `Couldn't show it in ${fileManagerName()}`,
        isNotImplemented(error) ? "Revealing files isn't available yet." : errorMessage(error),
      );
    }
  };
}
