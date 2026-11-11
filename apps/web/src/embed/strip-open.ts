import { createContext, useContext } from "react";

/**
 * Whether the hosted strip's sidebar is open over the page beside it: its tiles' tooltips then
 * keep away, since the sidebar says each name in full where a tooltip would cover it.
 */
export const StripOpen = createContext(false);

export const useStripOpen = () => useContext(StripOpen);
