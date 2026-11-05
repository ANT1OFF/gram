/**
 * Marks a card in the transcript whose controls hold still under the pointer, such as a failed
 * turn's Retry: while the pointer is on it, rows above it that grow move the scroll with them and
 * following waits, so it doesn't slide from under a click. The transcript's scroll has to have room
 * for that: in a transcript shorter than its view, a row above that grows still moves it down.
 */
export const HOLD_UNDER_POINTER = "data-hold-under-pointer";
