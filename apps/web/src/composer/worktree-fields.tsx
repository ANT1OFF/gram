import type { CheckoutRequest } from "@gram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dices } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { branchPrefixSetting } from "@/settings/branch-prefix";
import { useServerSettings } from "@/settings-sync/store";

import { BRANCH_PREFIXES, branchRef, randomBranchName, type BranchPrefix } from "./branch-name";

/** `WorktreeChoice.base` for "whatever the repository's default branch is". */
export const DEFAULT_BASE = "__default__";

const labelCls = "text-xs font-medium text-muted-foreground";
const inputCls =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export interface WorktreeChoice {
  prefix: BranchPrefix;
  name: string;
  /** A branch name, or the repo's default branch. */
  base: string;
}

export const initialWorktreeChoice = (): WorktreeChoice => ({
  prefix: branchPrefixSetting(useServerSettings.getState().settings?.agents.branchPrefix),
  name: randomBranchName(),
  base: DEFAULT_BASE,
});

export const worktreeCheckout = ({ prefix, name, base }: WorktreeChoice): CheckoutRequest => ({
  kind: "newWorktree",
  branch: branchRef(prefix, name),
  ...(base !== DEFAULT_BASE ? { base } : {}),
});

/** Branch prefix, name (with a random suggestion) and base branch for a new worktree. */
export function WorktreeFields({
  repoPath,
  value,
  onChange,
}: {
  repoPath: string;
  value: WorktreeChoice;
  onChange: (next: WorktreeChoice) => void;
}) {
  const api = useApi();
  const { data: branches } = useQuery({
    queryKey: ["branches", repoPath],
    queryFn: () => api.branches(repoPath),
    enabled: repoPath !== "",
  });
  const defaultLabel = branches?.default ?? "Default branch";

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className={labelCls}>Prefix</span>
        <Select
          value={value.prefix}
          items={BRANCH_PREFIXES.map((p) => ({ value: p, label: p }))}
          onValueChange={(next) => {
            if (next !== null) onChange({ ...value, prefix: next as BranchPrefix });
          }}
        >
          <SelectTrigger aria-label="Branch prefix" className="font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BRANCH_PREFIXES.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className={labelCls}>Branch name</span>
        <span className="flex gap-1">
          <input
            aria-label="Branch name"
            className={cn(inputCls, "font-mono text-xs")}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Random branch name"
            onClick={() => onChange({ ...value, name: randomBranchName() })}
          >
            <Dices />
          </Button>
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelCls}>Base branch</span>
        <Select
          value={value.base}
          items={[
            { value: DEFAULT_BASE, label: defaultLabel },
            ...(branches?.branches ?? []).map((name) => ({ value: name, label: name })),
          ]}
          onValueChange={(next) => {
            if (next !== null) onChange({ ...value, base: next });
          }}
        >
          <SelectTrigger aria-label="Base branch" className="font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_BASE}>{defaultLabel}</SelectItem>
            {(branches?.branches ?? []).map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {repoPath !== "" && value.base !== DEFAULT_BASE && (
        <BaseFreshness key={value.base} repoPath={repoPath} base={value.base} />
      )}
    </div>
  );
}

/** The same note for the current checkout, about its branch's `origin/` upstream when it has one. */
export function CurrentCheckoutFreshness({ repoPath }: { repoPath: string }) {
  const api = useApi();
  const upstream = useQuery({
    queryKey: ["git.upstreamStatus", repoPath],
    queryFn: () => api.upstreamStatus(repoPath),
    enabled: repoPath !== "",
    retry: false,
  });
  const ref = upstream.data?.ref;
  if (ref === undefined) return null;
  return (
    <>
      <BaseFreshness key={ref} repoPath={repoPath} base={ref} />
      <UpstreamSyncNote repoPath={repoPath} />
    </>
  );
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** "main is 2 commits behind origin/main", with a fast-forward when it's safe, or why it isn't. */
function UpstreamSyncNote({ repoPath }: { repoPath: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const sync = useQuery({
    queryKey: ["git.upstreamSync", repoPath],
    queryFn: () => api.upstreamSync(repoPath),
    retry: false,
  });
  const forward = useMutation({
    mutationFn: () => api.fastForward(repoPath),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["git.upstreamSync", repoPath] });
      void queryClient.invalidateQueries({ queryKey: ["branches", repoPath] });
    },
  });

  if (forward.isSuccess) {
    const { branch, ref, commits: moved } = forward.data;
    return (
      <p role="status" className="w-full text-xs text-muted-foreground">
        {`Fast-forwarded ${branch} by ${commits(moved)} to ${ref}.`}
      </p>
    );
  }
  const data = sync.data;
  if (!data || data.behind === 0 || data.branch === undefined || data.ref === undefined)
    return null;
  return (
    <p
      data-testid="upstream-sync"
      className="flex w-full flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>{`${data.branch} is ${commits(data.behind)} behind ${data.ref}.`}</span>
      {data.blocker === undefined ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={forward.isPending}
          onClick={() => forward.mutate()}
        >
          {forward.isPending ? "Fast-forwarding…" : "Fast-forward"}
        </Button>
      ) : (
        <span>{`Not fast-forwarding: ${data.blocker}.`}</span>
      )}
      {forward.isError && (
        <span role="alert" className="text-destructive">
          {errorMessage(forward.error)}
        </span>
      )}
    </p>
  );
}

/** Older fetches than this may have missed commits on the base branch. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * A quiet note when the picked base branch was last fetched long ago, with a one-click fetch. The
 * default base needs none: creating the worktree fetches it.
 */
function BaseFreshness({ repoPath, base }: { repoPath: string; base: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  // Staleness is judged when the status arrives, so rendering stays pure.
  const status = useQuery({
    queryKey: ["git.baseStatus", repoPath, base],
    queryFn: async () => {
      const { fetchedAt } = await api.baseStatus(repoPath, base);
      const now = Date.now();
      return {
        stale: fetchedAt === undefined || now - fetchedAt >= STALE_AFTER_MS,
        // Spelled out: the note is a sentence.
        lastFetched: fetchedAt === undefined ? undefined : agoText(fetchedAt, now, { long: true }),
      };
    },
    retry: false,
  });
  const fetch = useMutation({
    mutationFn: () => api.fetchBase(repoPath, base),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["git.baseStatus", repoPath, base] });
      void queryClient.invalidateQueries({ queryKey: ["branches", repoPath] });
      // A fetch can leave the current branch behind: let the fast-forward note see it.
      void queryClient.invalidateQueries({ queryKey: ["git.upstreamSync", repoPath] });
    },
  });

  if (fetch.isSuccess) {
    const n = fetch.data.newCommits;
    return (
      <p role="status" className="w-full text-xs text-muted-foreground">
        {n === 0
          ? `${base} is up to date.`
          : `Fetched ${n} new commit${n === 1 ? "" : "s"} into ${base}.`}
      </p>
    );
  }
  if (!status.isSuccess || !status.data.stale) return null;
  const { lastFetched } = status.data;
  return (
    <p
      data-testid="base-freshness"
      className="flex w-full flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>
        {lastFetched === undefined
          ? `This repo has never been fetched, so ${base} may be behind origin.`
          : `${base} may be behind origin: last fetched ${lastFetched}.`}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={fetch.isPending}
        onClick={() => fetch.mutate()}
      >
        {fetch.isPending ? "Fetching…" : "Fetch"}
      </Button>
      {fetch.isError && (
        <span role="alert" className="text-destructive">
          {errorMessage(fetch.error)}
        </span>
      )}
    </p>
  );
}
