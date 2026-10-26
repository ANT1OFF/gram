/**
 * Marks each child of `row` that wrapped past its first line `inert`, and clears the mark once it
 * fits again. The pane header's chips wrap and a fixed height hides every later line, but
 * `overflow: hidden` only stops the painting: a hidden Push or link still took Tab, and focusing it
 * scrolled the row off its first line.
 */
export function inertWrapped(row: HTMLElement): void {
  const top = row.getBoundingClientRect().top;
  for (const child of row.children) {
    if (!(child instanceof HTMLElement)) continue;
    child.inert = child.getBoundingClientRect().top - top >= row.clientHeight;
  }
  row.scrollTop = 0;
}

/**
 * A ref for the header's chip row that keeps `inertWrapped` true as the pane resizes and the chips
 * come, go, change their words or resize on their own (a font loading or a font override can move a
 * chip to another line with the row's size unchanged). Attribute changes aren't watched, so setting
 * `inert` doesn't loop.
 */
export const trackWrappedChips = (row: HTMLDivElement | null) => {
  if (row === null) return;
  const update = () => inertWrapped(row);
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
  const observe = () => {
    if (resize === undefined) return;
    resize.disconnect();
    resize.observe(row);
    for (const child of row.children) resize.observe(child);
  };
  observe();
  update();
  const mutations = new MutationObserver(() => {
    observe();
    update();
  });
  mutations.observe(row, { childList: true, subtree: true, characterData: true });
  return () => {
    resize?.disconnect();
    mutations.disconnect();
  };
};
