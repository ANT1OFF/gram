import { Menu } from "@base-ui/react/menu";
import { BookOpen, ChevronUp } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { Chapter } from "./parts";

const POPUP =
  "z-50 max-h-80 w-72 max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-y-auto rounded-(--radius-md) border border-border bg-popover p-1 text-popover-foreground shadow-(--shadow-raised) outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "block w-full cursor-default rounded-(--radius-sm) px-2 py-1.5 text-left text-sm wrap-anywhere outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

const targetClass =
  "group/turn flex h-6 w-full shrink-0 items-center rounded-(--radius-sm) px-3 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2";

/** One explicit history page per activation; the outline never implies unloaded history is complete. */
export interface OutlineHistory {
  earlier?: boolean;
  loadingEarlier?: boolean;
  earlierFailed?: boolean;
  onLoadEarlier?: (() => void) | undefined;
}

function earlierLabel(history: OutlineHistory) {
  return history.loadingEarlier
    ? "Loading earlier prompts and chapters…"
    : history.earlierFailed
      ? "Couldn't load earlier prompts and chapters. Try again"
      : "Load earlier prompts and chapters";
}

/** Scroll only this rail, leaving the transcript and focus owner alone. */
function keepInRail(rail: HTMLElement, button: HTMLElement) {
  const viewport = rail.getBoundingClientRect();
  const mark = button.getBoundingClientRect();
  if (mark.top < viewport.top + 16) rail.scrollTop += mark.top - viewport.top - 16;
  else if (mark.bottom > viewport.bottom - 16) rail.scrollTop += mark.bottom - viewport.bottom + 16;
}

/**
 * The thread header's chapter list. A menu, so Escape and a click outside close it, the arrows move
 * between chapters, and focus returns to the Contents button.
 */
export function TableOfContents({
  chapters,
  onJump,
  ...history
}: {
  chapters: readonly Chapter[];
  onJump: (messageId: string) => void;
} & OutlineHistory) {
  if (chapters.length === 0 && !history.earlier) return null;
  return (
    <Menu.Root>
      <Hint
        label="Contents · loaded prompts and chapters"
        render={
          <Menu.Trigger
            render={<Button size="icon-sm" variant="ghost" aria-label="Contents" />}
            className="shrink-0 text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground aria-expanded:text-foreground"
          />
        }
      >
        <BookOpen aria-hidden className="size-3.5" />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="toc" aria-label="Loaded conversation" className={POPUP}>
            <div className="px-2 py-1 text-xs text-muted-foreground">
              Loaded prompts and chapters
            </div>
            {history.earlier && history.onLoadEarlier && (
              <Menu.Item
                className={ITEM}
                disabled={history.loadingEarlier}
                onClick={history.onLoadEarlier}
              >
                {earlierLabel(history)}
              </Menu.Item>
            )}
            {chapters.map((chapter) => (
              <Menu.Item
                key={chapter.id}
                className={ITEM}
                onClick={() => onJump(chapter.messageId)}
              >
                {chapter.title}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Fits in the existing left gutter, leaving the transcript's reading width and scroll owner intact. */
export function ConversationRail({
  chapters,
  currentId,
  onJump,
  ...history
}: {
  chapters: readonly Chapter[];
  currentId: string | undefined;
  onJump: (messageId: string) => void;
} & OutlineHistory) {
  const railRef = useRef<HTMLElement>(null);
  const pagingFromRail = useRef<string>(undefined);
  // The transcript hands down a new `onJump` with every streamed frame. The chapter buttons call
  // the latest through a ref, so while the chapters stay the same none of their tooltips re-render.
  const latestJump = useRef(onJump);
  useLayoutEffect(() => {
    latestJump.current = onJump;
  });
  const jump = useCallback((messageId: string) => latestJump.current(messageId), []);
  const firstId = chapters[0]?.id;
  const { earlier, loadingEarlier, earlierFailed } = history;
  const available = chapters.length > 0 || earlier;
  // Disabling the loading button can blur it to body. That is not a new focus owner;
  // deliberate focus/input elsewhere retires this request's keyboard continuation.
  useEffect(() => {
    if (!available) return;
    const rail = railRef.current;
    if (!rail) return;
    const owner = rail.ownerDocument;
    const retire = (event: Event) => {
      if (pagingFromRail.current === undefined) return;
      if (event.target instanceof Node && rail.contains(event.target)) return;
      if (
        event.type === "focusin" &&
        (event.target === owner.body || event.target === owner.documentElement)
      )
        return;
      pagingFromRail.current = undefined;
    };
    const events = ["focusin", "pointerdown", "touchstart", "wheel", "keydown", "input"];
    for (const event of events) owner.addEventListener(event, retire, true);
    return () => {
      for (const event of events) owner.removeEventListener(event, retire, true);
    };
  }, [available]);
  useLayoutEffect(() => {
    if (!available) return;
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (rail.clientHeight === 0) return;
      const focused = rail.ownerDocument.activeElement;
      const target =
        focused instanceof HTMLElement && rail.contains(focused)
          ? focused
          : rail.querySelector<HTMLElement>('[aria-current="location"]');
      if (target) keepInRail(rail, target);
    });
    observer.observe(rail);
    return () => observer.disconnect();
  }, [available]);
  const currentIndex = chapters.findIndex((chapter) => chapter.id === currentId);
  useLayoutEffect(() => {
    if (currentIndex < 0) return;
    const rail = railRef.current;
    const current = rail?.querySelector<HTMLElement>('[aria-current="location"]');
    if (rail && current) keepInRail(rail, current);
  }, [currentIndex]);
  useLayoutEffect(() => {
    const from = pagingFromRail.current;
    if (from === undefined || loadingEarlier) return;
    if (firstId === from && earlier && !earlierFailed) return;
    pagingFromRail.current = undefined;
    const rail = railRef.current;
    const target =
      (earlierFailed
        ? undefined
        : rail?.querySelector<HTMLButtonElement>("button[data-outline-anchor]")) ??
      rail?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (rail && target) {
      target.focus({ preventScroll: true });
      keepInRail(rail, target);
    }
  }, [firstId, earlier, loadingEarlier, earlierFailed]);
  if (chapters.length === 0 && !history.earlier) return null;
  return (
    <nav
      ref={railRef}
      aria-label="Loaded conversation"
      data-testid="conversation-rail"
      className="absolute inset-y-0 left-2 z-10 hidden w-20 overflow-y-auto overscroll-contain py-4 @min-[60rem]:block [@media(pointer:coarse)]:hidden"
      onKeyDown={(event) => {
        if (!["Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        const rail = event.currentTarget;
        const buttons = [...rail.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (from === -1) return;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : Math.max(
                  0,
                  Math.min(buttons.length - 1, from + (event.key === "ArrowUp" ? -1 : 1)),
                );
        event.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
        if (buttons[next]) keepInRail(rail, buttons[next]);
      }}
    >
      {/* Auto margins center fitting lists; an overflowing list grows from its top, so both ends remain reachable. */}
      <div className="flex min-h-full flex-col">
        <div className="relative my-auto shrink-0">
          <span
            aria-hidden
            className="pointer-events-none absolute top-3 bottom-3 left-3 w-px bg-border/20"
          />
          {history.earlier && history.onLoadEarlier && (
            <Hint
              label={earlierLabel(history)}
              side="right"
              render={
                <button
                  type="button"
                  aria-label={earlierLabel(history)}
                  disabled={history.loadingEarlier}
                  onClick={() => {
                    pagingFromRail.current = firstId ?? "";
                    history.onLoadEarlier?.();
                  }}
                  className={cn(
                    targetClass,
                    "text-muted-foreground/60 hover:text-foreground disabled:opacity-40",
                  )}
                />
              }
            >
              <ChevronUp aria-hidden className="size-3" />
            </Hint>
          )}
          <RailChapters chapters={chapters} currentId={currentId} onJump={jump} railRef={railRef} />
        </div>
      </div>
    </nav>
  );
}

/**
 * The rail's chapter marks, one tooltip each. Memoized, since its parent renders with every streamed
 * frame and a long thread has hundreds: while the chapters, the current one and `onJump` stay the
 * same, none of them renders again.
 */
const RailChapters = memo(function RailChapters({
  chapters,
  currentId,
  onJump,
  railRef,
}: {
  chapters: readonly Chapter[];
  currentId: string | undefined;
  onJump: (messageId: string) => void;
  railRef: RefObject<HTMLElement | null>;
}) {
  return (
    <>
      {chapters.map((chapter) => (
        <Hint
          key={chapter.id}
          label={chapter.title}
          side="right"
          render={
            <button
              type="button"
              aria-label={chapter.title}
              data-outline-anchor={chapter.messageId}
              aria-current={chapter.id === currentId ? "location" : undefined}
              onClick={() => onJump(chapter.messageId)}
              onFocus={(event) => {
                const rail = railRef.current;
                if (rail) keepInRail(rail, event.currentTarget);
              }}
              className={targetClass}
            />
          }
        >
          <span
            aria-hidden
            className={cn(
              "h-0.5 w-6 origin-left rounded-full transition-[transform,background-color] duration-(--dur-fast) group-hover/turn:scale-x-100 group-hover/turn:bg-foreground/80 group-focus-visible/turn:scale-x-100 group-focus-visible/turn:bg-foreground/80",
              chapter.id === currentId
                ? "scale-x-[0.667] bg-foreground/75"
                : cn(
                    "bg-muted-foreground/45",
                    chapter.kind === "chapter" ? "scale-x-[0.5]" : "scale-x-[0.333]",
                  ),
            )}
          />
        </Hint>
      ))}
    </>
  );
});
