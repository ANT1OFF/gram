import { useLayoutEffect, useRef, useState, type UIEvent } from "react";

/** Within this many pixels of its bottom a view counts as following. */
const FOLLOW_SLACK = 24;

/**
 * Keeps a scrolling view at its bottom as `content` grows, as a terminal does, unless the user
 * scrolled up to read: then it stays put and `behind` says so, until `follow` (or scrolling back
 * down) takes it to the bottom again. Give `ref` and `onScroll` to the scrolling element.
 */
export function useFollowBottom<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
    // `content` is the signal, not an input: each time it grows, a following view goes down with it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [content]);
  const onScroll = (event: UIEvent<T>) => {
    const element = event.currentTarget;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
    following.current = atBottom;
    setBehind(!atBottom);
  };
  const follow = () => {
    following.current = true;
    setBehind(false);
    const element = ref.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  };
  return { ref, behind, onScroll, follow };
}
