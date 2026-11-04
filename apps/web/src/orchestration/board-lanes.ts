import { FEATURE_STATIONS, type FeatureStation } from "@gram/contracts";

import type { RailRow } from "./rail-model";

// How the Board spends its width: each station's lane as wide as its cards need, an empty one a
// slim labelled column, and below the width where cards stay legible, each line's cards stacked
// under its name by station rather than squeezed lanes. No React.

/** The feature column, beside the stations. */
export const FEATURE_COLUMN = "minmax(10rem,14rem)";
/** An empty station: wide enough for its label and its dot on the track. */
export const SLIM_LANE = "4.5rem";
/** The narrowest a lane with cards gets: a card's title stays on two legible lines. */
const CARD_MIN_REM = 11;
/** A lane's share of the spare width grows with its cards, up to this many. */
const MAX_WEIGHT = 3;

/** px per rem, as the theme sets the root size. */
const REM = 16;
const FEATURE_MIN_PX = 10 * REM;
const SLIM_PX = 4.5 * REM;
/** The lines' column gap (gap-x-2) between the six columns, and their side padding (px-4). */
const CHROME_PX = 5 * 0.5 * REM + 2 * REM;
/**
 * Below this the lanes give way to the list whatever the cards: a centre pane this narrow is one
 * beside an open side panel or in a small window, where the tracks would only squeeze the cards.
 */
const LANES_FLOOR_PX = 900;

/** How many cards each station holds across the lines: workers, and Briefed's held briefs. */
export const laneCounts = (
  rows: readonly Pick<RailRow, "cells" | "held">[],
): Readonly<Record<FeatureStation, number>> => {
  const counts = Object.fromEntries(FEATURE_STATIONS.map((station) => [station, 0])) as Record<
    FeatureStation,
    number
  >;
  for (const row of rows) {
    for (const station of FEATURE_STATIONS) counts[station] += row.cells[station].length;
    counts.briefed += row.held.length;
  }
  return counts;
};

/**
 * The lines' grid columns: the feature, then each station, an empty one slim and one with cards at
 * least a legible card wide, sharing what is left by how many cards it holds.
 */
export const laneTemplate = (counts: Readonly<Record<FeatureStation, number>>): string =>
  [
    FEATURE_COLUMN,
    ...FEATURE_STATIONS.map((station) =>
      counts[station] === 0
        ? SLIM_LANE
        : `minmax(${CARD_MIN_REM}rem,${Math.min(counts[station], MAX_WEIGHT)}fr)`,
    ),
  ].join(" ");

/** The narrowest pane that shows the lanes with every card at its legible width. */
export const lanesMinWidth = (counts: Readonly<Record<FeatureStation, number>>): number =>
  Math.max(
    LANES_FLOOR_PX,
    FEATURE_MIN_PX +
      CHROME_PX +
      FEATURE_STATIONS.reduce(
        (sum, station) => sum + (counts[station] === 0 ? SLIM_PX : CARD_MIN_REM * REM),
        0,
      ),
  );
