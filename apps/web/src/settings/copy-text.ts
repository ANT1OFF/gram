/** Puts `text` on the clipboard: through the desktop bridge in the app, the browser clipboard otherwise. */
export async function copyText(text: string): Promise<void> {
  const bridge = window.gram;
  if (bridge) return bridge.copyText(text);
  await navigator.clipboard.writeText(text);
}
