import {
  listsRepo,
  reviewRequestHolds,
  type PrStatus,
  type ReviewRequest,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useApi } from "@/api/context";
import { repoOfPrUrl } from "@/panels/pr-identity";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

/** The "Maximum age" presets; `off` lists a PR however long it has sat. */
export const MAX_AGE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;
export type MaxAgeChoice = (typeof MAX_AGE_OPTIONS)[number]["value"];

/** The cutoff as one of the presets; `undefined` for a stored value none of them names. */
export const maxAgeChoice = (days: number | undefined): MaxAgeChoice | undefined =>
  days === undefined
    ? "off"
    : MAX_AGE_OPTIONS.find((option) => option.value === String(days))?.value;

/** The patch a "Maximum age" choice stands for. */
export const maxAgePatch = (choice: MaxAgeChoice) => ({
  reviewRequestsMaxAgeDays: choice === "off" ? null : Number(choice),
});

type RequestsPatch = NonNullable<SettingsPatch["notifications"]>;

const pushRepo = (repos: string[], repo: string) => {
  if (!listsRepo(repos, repo)) repos.push(repo);
};

/** The repositories of `prs` that a configured review bot has reviewed, in order, once each. */
export function botReviewedRepos(prs: readonly Pick<PrStatus, "url" | "review">[]): string[] {
  const repos: string[] = [];
  for (const pr of prs) {
    const repo = repoOfPrUrl(pr.url);
    if (repo !== undefined && (pr.review?.bots.length ?? 0) > 0) pushRepo(repos, repo);
  }
  return repos;
}

/**
 * The repositories a configured review bot is known to review, sorted: it has reviewed one of
 * `requests`, or one of the user's own PRs (`prRepos`, from `botReviewedRepos`). Only what the app
 * already holds, so nothing is asked of GitHub.
 */
export function suggestedBotRepos(
  requests: readonly Pick<ReviewRequest, "repo" | "bot">[],
  prRepos: readonly string[],
): string[] {
  const repos: string[] = [];
  for (const request of requests) if (request.bot !== undefined) pushRepo(repos, request.repo);
  for (const repo of prRepos) pushRepo(repos, repo);
  return repos.toSorted((a, b) => a.localeCompare(b));
}

/**
 * The request is held for a review bot that has never reviewed it, which may be because its
 * repository has none. One a bot has reviewed, on any commit, shows the repository has one.
 */
export const heldForMissingBot = (settings: Settings, request: ReviewRequest): boolean =>
  request.bot === undefined && reviewRequestHolds(settings, request.repo).bot;

/** `owner/name` from what was typed, a repository or pull request URL included. */
export function parseRepo(input: string): string | undefined {
  const text = input.trim().replace(/\.git$/, "");
  const url = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)(?:\/|$)/i.exec(text);
  const repo = url?.[1] ?? text;
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined;
}

/** The list with `repo` added; a repository it already has, in any case, leaves it as it is. */
export const withBotRepo = (repos: readonly string[], repo: string): string[] =>
  listsRepo(repos, repo) ? [...repos] : [...repos, repo];

/**
 * The patch that says `repo` has no review bot. A list never filled in held every repository, so
 * it starts from `suggested` rather than from nothing, which would release them all.
 */
export const noBotRepoPatch = (
  listed: readonly string[] | undefined,
  suggested: readonly string[],
  repo: string,
) => ({
  reviewBotRepos: (listed ?? suggested).filter((known) => !listsRepo([known], repo)),
});

/**
 * Which review requests are listed, and how to change it: Settings → Notifications and the sidebar
 * section's right-click menu are two views of these. Both filters are on unless turned off.
 *
 * `apply` saves, then forces a poll, so the list is rebuilt at once for the new filter and a widened
 * one seeds silently instead of notifying for every PR it brings back.
 */
export function useReviewRequestFilters() {
  const notifications = useServerSettings((s) => s.settings?.notifications);
  const save = useSaveSettings();
  const api = useApi();
  const queryClient = useQueryClient();
  const apply = useCallback(
    async (patch: RequestsPatch) => {
      await save({ notifications: patch });
      await api.refreshReviewRequests({ force: true });
      await queryClient.invalidateQueries({ queryKey: ["reviewRequests"] });
    },
    [save, api, queryClient],
  );
  return {
    directOnly: notifications?.reviewRequestsDirectOnly !== false,
    hideBots: notifications?.reviewRequestsHideBots !== false,
    maxAge: maxAgeChoice(notifications?.reviewRequestsMaxAgeDays),
    apply,
  };
}
