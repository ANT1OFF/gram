import type { ThreadId } from "@gram/contracts";
import { createContext, useContext, type MouseEvent } from "react";

import { openBesideFrom } from "./beside-store";

/**
 * The orchestrator whose workers' links open beside its chat: the orchestrator's own view provides
 * it, and so does a worker open beside it, whose links to its siblings swap the Thread tab.
 * Elsewhere (a solo thread, a worker in its own view) it is absent, and links navigate.
 */
export const BesideLinkScope = createContext<ThreadId | undefined>(undefined);

/**
 * A link's click handler for `target`: a plain click on a link to a worker of the orchestrator in
 * scope opens it in the right panel's Thread tab, beside the chat, without leaving it. A click with
 * a modifier, or on any other thread, is left to the link, which opens the thread full width.
 */
export function useBesideLink(target: ThreadId | undefined) {
  const scope = useContext(BesideLinkScope);
  return (event: MouseEvent<HTMLElement>) => {
    if (scope === undefined || target === undefined || event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (openBesideFrom(scope, target)) event.preventDefault();
  };
}
