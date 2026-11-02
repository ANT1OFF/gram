import { projectNamesOn, voiceVocabularyOf, type ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";

import { buildVocabularyIndex, EMPTY_VOCABULARY, type VocabularyIndex } from "./vocabulary";

const NO_TERMS = [] as const;

/**
 * The vocabulary dictation spells with in a composer: the user's list, and with "Use this
 * project's names" on, the names in `threadId`'s checkout. The project's names are only asked for
 * once `wanted`, when dictation is about to be used, so opening a thread runs no git for it.
 */
export function useVocabularyIndex(
  threadId: ThreadId | undefined,
  wanted: boolean,
): VocabularyIndex {
  const api = useApi();
  const settings = useServerSettings((s) => s.settings);
  const user = settings === undefined ? NO_TERMS : voiceVocabularyOf(settings);
  const projectOn = settings !== undefined && projectNamesOn(settings);
  const project = useQuery({
    queryKey: ["fs.vocabulary", threadId],
    queryFn: () => api.projectVocabulary(threadId!),
    enabled: wanted && projectOn && threadId !== undefined,
    retry: false,
    staleTime: 60_000,
  });
  const terms = projectOn ? (project.data?.terms ?? NO_TERMS) : NO_TERMS;
  return useMemo(
    () =>
      user.length === 0 && terms.length === 0
        ? EMPTY_VOCABULARY
        : buildVocabularyIndex(user, terms),
    [user, terms],
  );
}
