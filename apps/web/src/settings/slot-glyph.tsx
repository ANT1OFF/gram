import {
  isPinned,
  recommendedSetupOn,
  TIERS,
  tierName,
  type ModelSlot,
  type Tier,
} from "@gram/contracts";
import { Pin, RotateCcw, Sparkles } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";

// Whether a model slot follows the recommendation or is the user's own, as a glyph before its
// chip with the words on hover, and the Follow recommended button after a pinned one's chip
// (mock: recommended-setup v1, boards 3 and 4). Nothing shows while the mode is off.

/** The words behind a following slot's glyph: "Recommended · Lead tier · updates with Gram". */
export const followsWords = (tier: string): string =>
  `Recommended · ${(TIERS as readonly string[]).includes(tier) ? tierName(tier as Tier) : tier} tier · updates with Gram`;

/** The words behind a pinned slot's glyph. */
export const YOURS_WORDS = "Your choice · updates leave it alone";

/** The Follow recommended button's words. */
export const FOLLOW_WORDS = "Follow recommended";

/** Whether the recommended setup is on, so slots carry their glyphs. */
export function useRecommendedOn(): boolean {
  return useServerSettings((state) =>
    state.settings === undefined ? false : recommendedSetupOn(state.settings),
  );
}

/**
 * `slot`'s glyph: sparkles in the accent when it follows a tier, a muted pin when it is the user's.
 * Nothing for an unset slot, or while the recommended setup is off.
 */
export function SlotGlyph({ slot }: { slot: ModelSlot | undefined }) {
  const on = useRecommendedOn();
  if (!on || slot === undefined) return null;
  const follows = !isPinned(slot);
  const words = follows && "tier" in slot ? followsWords(slot.tier) : YOURS_WORDS;
  const Icon = follows ? Sparkles : Pin;
  return (
    <Hint
      label={words}
      render={
        <span
          role="img"
          tabIndex={0}
          aria-label={words}
          data-testid="slot-glyph"
          data-follows={follows || undefined}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:focus-ring",
            follows ? "text-link" : "text-muted-foreground",
          )}
        />
      }
    >
      <Icon aria-hidden className="size-icon-row" />
    </Hint>
  );
}

/**
 * The Follow recommended icon button after a pinned slot's chip: moves it back to following. Nothing
 * for a slot that already follows, when there is no tier to follow, or while the mode is off.
 */
export function FollowButton({
  slot,
  disabled = false,
  onFollow,
}: {
  slot: ModelSlot | undefined;
  disabled?: boolean | undefined;
  /** Moves the slot back to following; absent when no tier runs it here. */
  onFollow: (() => void) | undefined;
}) {
  const on = useRecommendedOn();
  if (!on || slot === undefined || !isPinned(slot) || onFollow === undefined) return null;
  return (
    <Hint
      label={FOLLOW_WORDS}
      render={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={FOLLOW_WORDS}
          data-testid="slot-follow"
          disabled={disabled}
          onClick={onFollow}
        />
      }
    >
      <RotateCcw />
    </Hint>
  );
}
