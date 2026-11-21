// The preview's element picking, for the user's next message: on loopback pages only, never a web
// page with the user's sign-ins, whose content no agent reads.

import type { WebContents } from "electron";

import { Channels } from "../../channels.ts";
import type { ShellIpc } from "../ipc.ts";
import { CANCEL_PICK_SCRIPT, PICK_SCRIPT, PICK_WORLD, parsePicked } from "./pick.ts";

/** The thread's page an IPC message names, as the preview module finds it. */
export type PreviewLookup = (
  input: unknown,
  sender: WebContents,
) =>
  | { readonly kind: "local" | "web"; readonly view: { readonly webContents: WebContents } }
  | undefined;

/** Serves `pick` and `cancelPick` for every window. */
export function installPickHandlers(ipc: ShellIpc, previewFor: PreviewLookup): void {
  ipc.handle(Channels.previewPick, async (input, event) => {
    const preview = previewFor(input, event.sender);
    if (preview === undefined || preview.kind !== "local") return null;
    const contents = preview.view.webContents;
    if (contents.isDestroyed()) return null;
    const url = contents.getURL();
    contents.focus();
    try {
      const picked: unknown = await contents.executeJavaScriptInIsolatedWorld(
        PICK_WORLD,
        [{ code: PICK_SCRIPT }],
        true,
      );
      // A page that moved on while picking says nothing of the one the user saw.
      if (contents.isDestroyed() || contents.getURL() !== url) return null;
      return parsePicked(picked, url);
    } catch {
      return null;
    }
  });
  ipc.on(Channels.previewPickCancel, (event, input) => {
    const preview = previewFor(input, event.sender);
    const contents = preview?.view.webContents;
    if (contents === undefined || contents.isDestroyed()) return;
    void contents
      .executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: CANCEL_PICK_SCRIPT }])
      .catch(() => undefined);
  });
}
