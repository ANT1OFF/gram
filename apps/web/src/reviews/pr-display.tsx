import { Bot, Clock3, UserRound } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import { Hint } from "@/components/hint";
import { prFactsOfListPr } from "@/components/pr-facts";
import { PR_GLYPH_DISPLAY, prGlyphOf, type PrGlyphState } from "@/components/pr-glyph-model";
import { PrMarkLines } from "@/components/pr-marks";
import { prMarksOf, prRefText } from "@/components/pr-marks-model";
import { agoText, formatMessageTime, formatRelative } from "@/lib/time";
import { informationCached, statusCached, type PrInformation } from "./pr-list-model";

import { cn } from "@/lib/utils";
import type { ReviewRequestsPlacement } from "@/stores/layout";

// Review-request and own-PR rows and their hover cards in the PR vocabulary (`pr-marks-model.ts`),
// from what a list row knows of its open PR (`prFactsOfListPr`), as the overview's rows have it.

/** Where either list can show, as its menu and Settings → Notifications offer it. */
export const PLACEMENT_OPTIONS = [
  { value: "sidebar", label: "Sidebar" },
  { value: "panel", label: "Right panel" },
  { value: "hidden", label: "Hidden" },
] as const satisfies readonly { value: ReviewRequestsPlacement; label: string }[];

export const CARD_SURFACE =
  "origin-(--transform-origin) rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";

/** Enter the scrollable preview without changing the row's Tab/owning-thread order. */
export function usePrCardFocus() {
  const triggerRef = useRef<HTMLElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const setTriggerRef = (element: HTMLElement | null) => {
    triggerRef.current = element;
  };
  const triggerKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" || popupRef.current === null) return;
    event.preventDefault();
    event.stopPropagation();
    popupRef.current.focus();
  };
  const popupKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") triggerRef.current?.focus();
  };
  return { setTriggerRef, popupRef, triggerKey, popupKey };
}

/** Cards open away from the window edge the list sits against. */
export type CardSide = "left" | "right";

/** A row's marks spelled out for its card; a cached status says so on each line. */
export function PrStatusDetails({ pr }: { pr: PrInformation }) {
  return <PrMarkLines marks={prMarksOf(prFactsOfListPr(pr))} cached={statusCached(pr)} />;
}

/** The state glyph the sidebar's thread rows draw, from what a list row knows of its open PR. */
export const listPrGlyph = (pr: PrInformation): PrGlyphState => prGlyphOf(prFactsOfListPr(pr));

/**
 * Compact shared content, inside the existing GitHub row button in either list. One glyph in its
 * state's colour stands for the row's status; the card spells the marks out.
 */
export function PrRowInformation({
  pr,
  grouped,
  glyphTestId,
  ageTestId,
}: {
  pr: PrInformation;
  grouped: boolean;
  glyphTestId: string;
  ageTestId?: string;
}) {
  const labelCount = pr.labelsCount ?? pr.labels?.length ?? 0;
  const ref = prRefText(pr);

  const activity = Date.parse(pr.updatedAt);
  const glyph = listPrGlyph(pr);
  const GlyphIcon = PR_GLYPH_DISPLAY[glyph.kind].icon;
  const word = statusCached(pr) ? `Cached: ${glyph.word}` : glyph.word;
  const author = pr.isBot === true ? pr.author?.replace(/\[bot\]$/, "") : pr.author;
  return (
    <>
      <span className="flex min-w-0 items-start gap-1.5">
        <Hint
          label={word}
          render={
            <span
              role="img"
              aria-label={word}
              data-testid={glyphTestId}
              data-state={glyph.kind}
              className="mt-0.5 shrink-0"
            />
          }
        >
          <GlyphIcon
            aria-hidden
            className={cn(
              "size-3.5",
              PR_GLYPH_DISPLAY[glyph.kind].tone,
              statusCached(pr) && "opacity-60",
            )}
          />
        </Hint>
        <span className="min-w-0 flex-1 line-clamp-2 break-words font-medium text-[13px] leading-4">
          {pr.title || ref}
        </span>
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          <span>{grouped ? `#${pr.number}` : ref}</span>
          {author && (
            <span aria-label={`Author ${pr.author}${pr.isBot ? " (bot)" : ""}`}>
              {" "}
              · {pr.isBot === true && <Bot aria-hidden className="mr-0.5 inline size-3" />}
              {author}
            </span>
          )}
        </span>
      </span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 pl-5 text-[10px] text-muted-foreground">
        <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
          {pr.labels?.slice(0, 1).map((label) => (
            <span key={label} className="max-w-24 truncate rounded-sm bg-muted px-1" title={label}>
              {label}
            </span>
          ))}
          {labelCount > 1 && (
            <span aria-label={`${labelCount - 1} more labels`} className="shrink-0">
              +{labelCount - 1}
            </span>
          )}
          <PrDiffStats pr={pr} />
        </span>
        {!Number.isNaN(activity) && (
          <Hint
            label={`Last activity ${formatMessageTime(activity)}`}
            render={
              <span
                aria-label={`Last activity ${agoText(activity)}`}
                data-testid={ageTestId}
                className="ml-auto flex shrink-0 items-center gap-0.5 tabular-nums"
              />
            }
          >
            <Clock3 aria-hidden className="size-2.5" />
            {formatRelative(activity)}
          </Hint>
        )}
      </span>
    </>
  );
}

function PrDiffStats({ pr }: { pr: PrInformation }) {
  if (pr.additions === undefined && pr.deletions === undefined) return null;
  const cached = informationCached(pr);
  return (
    <Hint
      label={cached ? "Cached change size · latest details unavailable" : "Lines added / deleted"}
      render={
        <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1 font-mono tabular-nums" />
      }
    >
      {cached && <Clock3 aria-hidden className="size-2.5" />}
      {pr.additions !== undefined && (
        <span
          aria-label={`${pr.additions} lines added${cached ? " (cached)" : ""}`}
          className="whitespace-nowrap text-success"
        >
          +{pr.additions.toLocaleString()}
        </span>
      )}
      {pr.deletions !== undefined && (
        <span
          aria-label={`${pr.deletions} lines deleted${cached ? " (cached)" : ""}`}
          className="whitespace-nowrap text-destructive"
        >
          −{pr.deletions.toLocaleString()}
        </span>
      )}
    </Hint>
  );
}

/** Full metadata on hover and keyboard focus. Status text stays with the existing cards. */
export function PrInformationDetails({ pr }: { pr: PrInformation }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {pr.author && (
        <p className="flex items-center gap-1 break-all">
          {pr.isBot ? (
            <Bot aria-hidden className="size-3 shrink-0" />
          ) : (
            <UserRound aria-hidden className="size-3 shrink-0" />
          )}
          {pr.author}
          {pr.isBot && " · Bot"}
        </p>
      )}
      {pr.headRef && <p className="break-all font-mono">{pr.headRef}</p>}
      {pr.labels !== undefined && pr.labels.length > 0 && (
        <p className="break-words">
          Labels: {pr.labels.join(", ")}
          {(pr.labelsCount ?? 0) > pr.labels.length &&
            ` · ${pr.labelsCount! - pr.labels.length} more labels not loaded`}
          {informationCached(pr) && " (cached)"}
        </p>
      )}
      <PrDiffStats pr={pr} />
      {[
        ["Opened", pr.createdAt],
        ["Activity", pr.updatedAt],
      ].map(([label, stamp]) => {
        const at = Date.parse(stamp ?? "");
        return Number.isNaN(at) ? null : (
          <p key={label}>
            {label} {formatMessageTime(at)}
          </p>
        );
      })}
      {informationCached(pr) && (
        <p>Supplementary details are cached; not refreshed for this activity.</p>
      )}
    </div>
  );
}

/** Chromium on macOS does not synthesize contextmenu for Shift+F10. Keep the same menu route. */
export function prContextMenuKey(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: rect.left + 12,
      clientY: rect.top + 12,
    }),
  );
}
