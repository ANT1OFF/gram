import { FEATURE_STATIONS, type FeatureCard, type FeatureCardWorker } from "@gram/contracts";
import { createContext, use } from "react";

import { railTone, workerTone, type RailFacts, type RailTone } from "./rail-model";

// A feature card's workers take the dot every other view draws for them (`StatusDot`), from the
// same facts the Board's rail reads. They are provided once per orchestrator chat, beside its
// stream and not in it: a worker starting or asking moves its dot, never the chat's messages.

/** What the workspace knows of its workers, for the cards of an orchestrator's chat. */
export const CardFactsContext = createContext<RailFacts | undefined>(undefined);

/**
 * A card worker's tone: the one the sidebar, the Board and Workers show, or, with no facts beside
 * the card, what the card's own state says.
 */
export const cardWorkerTone = (
  worker: FeatureCardWorker,
  facts: RailFacts | undefined,
): RailTone =>
  facts === undefined
    ? workerTone({
        asking: false,
        state: worker.state,
        failed: worker.flag === "error",
        // With no thread to read, a worker its card has at work is at work.
        working: worker.state === "working" || worker.state === "briefed",
      })
    : railTone(worker, facts);

/** The tone of one of a card's workers, in an orchestrator's chat or outside one. */
export const useCardWorkerTone = (worker: FeatureCardWorker): RailTone =>
  cardWorkerTone(worker, use(CardFactsContext));

/**
 * Whether a card's stage line says something its worker lines don't: a worker past Working (in
 * checks, in review, merged), or workers at different stations. With every worker briefed or
 * working it only drew "Working" over lines that say so.
 */
export const stageLineShown = (card: FeatureCard): boolean => {
  const past = FEATURE_STATIONS.indexOf("working");
  if (FEATURE_STATIONS.indexOf(card.station) > past) return true;
  const stations = new Set(card.workers.map((worker) => worker.station));
  return stations.size > 1 || [...stations].some((s) => FEATURE_STATIONS.indexOf(s) > past);
};

/**
 * A card with nothing to report: one worker at work, with no PR, no overlap, no held brief and no
 * stage of somebody's own. It is drawn as one line, its name, its worker and what the worker does,
 * and grows back into a card the moment the worker asks, fails, waits or opens a PR, or a second
 * worker joins. Its helper sentence isn't asked for: there is nothing for it to add.
 */
export const calmCard = (
  card: FeatureCard,
  tone: (worker: FeatureCardWorker) => RailTone,
): boolean => {
  const [worker, ...others] = card.workers;
  return (
    worker !== undefined &&
    others.length === 0 &&
    card.held === undefined &&
    card.stage === undefined &&
    worker.prs.length === 0 &&
    worker.overlapsWith.length === 0 &&
    tone(worker) === "working" &&
    !stageLineShown(card)
  );
};
