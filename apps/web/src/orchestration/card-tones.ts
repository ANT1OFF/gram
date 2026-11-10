import type { FeatureCardWorker } from "@gram/contracts";
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
