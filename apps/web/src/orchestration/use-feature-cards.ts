import {
  cardShown,
  currentSummary,
  mergeFeatureCards,
  type FeatureCard,
  type FeatureCards,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useApi } from "@/api/context";
import type { Api } from "@/api/types";

import { createLedgerWatch, type LedgerWatch } from "./ledger-watch";

// A workspace's live feature cards (contracts `feature-cards.ts`), kept current by one
// `watchFeatureCards` stream per workspace however many views show them: the orchestrator's stream,
// the Board, the Quiet status strip. A newer card replaces an older one in the cache, never the
// other way round.

const NO_CARDS: readonly FeatureCard[] = [];

const featureCardsKey = (workspaceId: WorkspaceId) => ["featureCards", workspaceId] as const;

const watches = new WeakMap<Api, LedgerWatch>();

const watchFor = (api: Api, queryClient: QueryClient): LedgerWatch => {
  let watch = watches.get(api);
  if (watch === undefined) {
    watch = createLedgerWatch<FeatureCards>({
      open: (workspaceId, signal) => api.watchFeatureCards(workspaceId, signal),
      publish: (cards) =>
        queryClient.setQueryData<FeatureCards>(featureCardsKey(cards.workspaceId), (current) =>
          mergeFeatureCards(current, cards),
        ),
    });
    watches.set(api, watch);
  }
  return watch;
};

/** One workspace's feature cards, oldest first, kept live for as long as something shows them. */
export function useFeatureCards(workspaceId: WorkspaceId | undefined): readonly FeatureCard[] {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (workspaceId === undefined) return;
    return watchFor(api, queryClient).retain(workspaceId);
  }, [api, queryClient, workspaceId]);
  const { data } = useQuery({
    queryKey: featureCardsKey(workspaceId ?? ("" as WorkspaceId)),
    queryFn: async () => {
      const next = await api.featureCards(workspaceId!);
      return mergeFeatureCards(
        queryClient.getQueryData<FeatureCards>(featureCardsKey(workspaceId!)),
        next,
      );
    },
    enabled: workspaceId !== undefined,
    retry: false,
  });
  const cards = data?.cards ?? NO_CARDS;
  // A card left with no worker and no held brief (one dropped before it spawned) is drawn nowhere.
  return useMemo(() => (cards.every(cardShown) ? cards : cards.filter(cardShown)), [cards]);
}

/**
 * The helper's sentence for `card`'s current version: the one the card carries, else asked for
 * once per version (served from the server's cache when only now lines moved). `undefined` with
 * helpers off; the card is complete without it.
 */
export function useFeatureSummary(card: FeatureCard): string | undefined {
  const api = useApi();
  const carried = currentSummary(card);
  const { data } = useQuery({
    queryKey: ["featureSummary", card.workspaceId, card.feature, card.version] as const,
    queryFn: () => api.featureSummary(card.workspaceId, card.feature),
    enabled: carried === undefined,
    staleTime: Infinity,
    retry: false,
  });
  if (carried !== undefined) return carried;
  return data != null && data.version === card.version ? data.text : undefined;
}
