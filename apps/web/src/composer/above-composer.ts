/** What Floating UI positions against: a box, and the element whose scrolling moves it. */
export interface ComposerAnchor {
  getBoundingClientRect: () => DOMRect;
  contextElement: Element;
}

/**
 * Where a toolbar picker's list opens from: the trigger's column, but its top at the top of the
 * composer it sits in, so a list opened above it clears the whole composer and never covers the
 * draft being written. Outside a composer (a settings form), the trigger itself.
 */
export function aboveComposer(trigger: Element | null): Element | ComposerAnchor | null {
  const slab = trigger?.closest('[data-surface="composer"]');
  if (!trigger || !slab) return trigger;
  return {
    contextElement: trigger,
    getBoundingClientRect: () => {
      const own = trigger.getBoundingClientRect();
      const top = Math.min(own.top, slab.getBoundingClientRect().top);
      return DOMRect.fromRect({ x: own.x, y: top, width: own.width, height: own.bottom - top });
    },
  };
}
