import {
  cardShown,
  currentSummary,
  mergeFeatureCards,
  type FeatureCard,
  type FeatureCards,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/api/context";
import type { Api } from "@/api/types";
import { useSubscription } from "@/lib/effects";

import { createLedgerWatch, type LedgerWatch } from "./ledger-watch";
import { useAnsweredWorkers } from "./needs-you-store";
import { answeredCards } from "./overview-model";

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
  useSubscription(() => {
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
  const answered = useAnsweredWorkers();
  return useMemo(
    () => answeredCards(cards.every(cardShown) ? cards : cards.filter(cardShown), answered),
    [cards, answered],
  );
}

/**
 * The helper's sentence for `card`'s current version: the one the card carries, else asked for
 * once per version (served from the server's cache when only now lines moved). `undefined` with
 * helpers off, or for a card with nothing to sum up; the card is complete without it.
 */
export function useFeatureSummary(card: FeatureCard, wanted = true): string | undefined {
  const api = useApi();
  const carried = currentSummary(card);
  const { data } = useQuery({
    queryKey: ["featureSummary", card.workspaceId, card.feature, card.version] as const,
    queryFn: () => api.featureSummary(card.workspaceId, card.feature),
    enabled: wanted && carried === undefined,
    staleTime: Infinity,
    retry: false,
  });
  if (carried !== undefined) return carried;
  return data != null && data.version === card.version ? data.text : undefined;
}
