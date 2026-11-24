import type { GitState, PrStatus, UpstreamState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProcError } from "./errors.ts";
import { dirtyContentHash, git, porcelainChanges, stableHash } from "./exec.ts";
import type { Proc } from "./proc.ts";
import { rebaseDone } from "./pr.ts";
import { isBranchName } from "./ref-format.ts";
import { localBaseRef, originTips } from "./refs.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const notARepoState: GitState = {
  repo: false,
  worktree: false,
  head: "",
  changesToken: "",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
};

/** Linked worktrees keep their git dir under `…/.git/worktrees/<name>`. Topology, not provenance. */
export const isLinkedWorktree = (gitDir: string): boolean =>
  gitDir.replaceAll("\\", "/").includes("/worktrees/");

/**
 * The local tier for `cwd`. A timed-out probe fails, since a killed `status` is byte-identical to a
 * clean tree; a genuine non-repo succeeds with `repo: false`.
 */
export const localGitState = (cwd: string): Effect.Effect<GitState, ProcError, Proc> =>
  Effect.gen(function* () {
    const info = yield* git(cwd, [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "HEAD",
      "--abbrev-ref",
      "HEAD",
    ]);
    const [topLine, gitDirLine, oidLine, branchLine] = info.stdout
      .split("\n")
      .map((line) => line.trim());
    if (!topLine) return notARepoState;
    const top = topLine;
    const born = oidLine !== undefined && /^[0-9a-f]{40,64}$/.test(oidLine);
    const headOid = born ? oidLine : "";
    const status = (yield* git(top, ["-c", "core.quotepath=false", "status", "--porcelain"]))
      .stdout;
    const stagedAny = status
      .split("\n")
      .some((line) => line.length > 2 && line[0] !== " " && line[0] !== "?");
    const staged = stagedAny
      ? (yield* git(top, ["diff", "--cached", "--raw", "--no-abbrev", "--no-renames"])).stdout
      : "";
    const branch =
      !born || branchLine === undefined || !isBranchName(branchLine) ? undefined : branchLine;
    return {
      repo: true,
      ...(branch === undefined ? {} : { branch }),
      worktree: isLinkedWorktree(gitDirLine ?? ""),
      head: headOid,
      changesToken: stableHash([top, headOid, status, dirtyContentHash(top, status), staged]),
      changedFiles: porcelainChanges(status),
      behindBase: 0,
      aheadBase: 0,
      conflicts: false,
    } satisfies GitState;
  });

export const classifyUpstream = (behind: number, ahead: number): UpstreamState =>
  behind > 0 ? (ahead > 0 ? "diverged" : "behind") : ahead > 0 ? "ahead" : "synced";

const parseCounts = (stdout: string) => {
  const [behind, ahead] = stdout
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 10));
  return {
    behind: Number.isFinite(behind) ? (behind as number) : 0,
    ahead: Number.isFinite(ahead) ? (ahead as number) : 0,
  };
};

const PAIR_MEMO_MAX = 1024;

const pairMemo = <A>() => {
  const memo = new Map<string, A>();
  return {
    get: (key: string) => {
      const hit = memo.get(key);
      if (hit === undefined) return undefined;
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    },
    set: (key: string, value: A) => {
      memo.set(key, value);
      if (memo.size > PAIR_MEMO_MAX) memo.delete(memo.keys().next().value!);
    },
  };
};
const counted = pairMemo<{ readonly behind: number; readonly ahead: number }>();
const merged = pairMemo<boolean>();

const isOid = (name: string | undefined): name is string =>
  name !== undefined && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(name);

const countsBetween = (cwd: string, left: string, right: string) =>
  Effect.gen(function* () {
    const key = `${left}...${right}`;
    const known = counted.get(key);
    if (known !== undefined) return known;
    const out = yield* git(cwd, ["rev-list", "--left-right", "--count", key]);
    if (out.status !== 0) return undefined;
    const counts = parseCounts(out.stdout);
    counted.set(key, counts);
    return counts;
  });

const conflictsBetween = (cwd: string, base: string, head: string) =>
  Effect.gen(function* () {
    const key = `${base} ${head}`;
    const known = merged.get(key);
    if (known !== undefined) return known;
    const trial = yield* git(cwd, ["merge-tree", "--write-tree", base, head]).pipe(Effect.option);
    if (Option.isNone(trial) || (trial.value.status !== 0 && trial.value.status !== 1))
      return false;
    const conflicts = trial.value.status === 1;
    merged.set(key, conflicts);
    return conflicts;
  });

const upstreamState = (cwd: string, branch: string, head: string, tip: string | undefined) =>
  Effect.gen(function* () {
    if (tip === undefined) return undefined;
    if (tip === head) return { upstream: "synced" as const, ahead: 0 };
    const counts =
      isOid(tip) && isOid(head)
        ? yield* countsBetween(cwd, tip, head)
        : yield* git(cwd, [
            "rev-list",
            "--left-right",
            "--count",
            `refs/remotes/origin/${branch}...HEAD`,
          ]).pipe(Effect.map((out) => (out.status === 0 ? parseCounts(out.stdout) : undefined)));
    if (counts === undefined) return undefined;
    return { upstream: classifyUpstream(counts.behind, counts.ahead), ahead: counts.ahead };
  });

const resolveBase = (
  branch: string,
  prBase: string | undefined,
  localBase: string | undefined,
  tips: ReadonlyMap<string, string>,
) =>
  prBase !== undefined
    ? tips.has(prBase)
      ? `origin/${prBase}`
      : undefined
    : localBase === `origin/${branch}`
      ? undefined
      : localBase;

export const clearRebaseTier = (state: GitState): GitState => {
  const {
    base: _base,
    upstream: _upstream,
    aheadUpstream: _aheadUpstream,
    headOnRemote: _headOnRemote,
    ...rest
  } = state;
  return { ...rest, behindBase: 0, aheadBase: 0, conflicts: false };
};

const headOnRemote = (cwd: string, state: GitState) =>
  Effect.gen(function* () {
    if (state.head === "") return false;
    if (state.upstream === "synced" || state.upstream === "behind") return true;
    if (state.base !== undefined && state.aheadBase === 0) return true;
    const out = yield* git(cwd, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "--contains",
      state.head,
      "refs/remotes",
    ]);
    return out.status === 0 && out.stdout.trim() !== "";
  });

const withHeadOnRemote = (cwd: string, state: GitState) =>
  headOnRemote(cwd, state).pipe(Effect.map((onRemote) => ({ ...state, headOnRemote: onRemote })));

/**
 * Fill base / behind / ahead / conflicts / upstream / head on a remote from remote-tracking refs (no
 * fetch). Conflicts run a `git merge-tree --write-tree` trial only when diverged, since otherwise a
 * merge fast-forwards.
 * A timeout fails so the caller restores what it carried rather than publishing zeros.
 */
export const fillRebase = (
  cwd: string,
  state: GitState,
  prBase: string | undefined,
): Effect.Effect<GitState, ProcError, Proc> =>
  Effect.gen(function* () {
    const cleared: Mutable<GitState> = { ...clearRebaseTier(state) };
    const branch = state.branch;
    if (branch === undefined || state.head === "") return yield* withHeadOnRemote(cwd, cleared);
    const localBase = prBase === undefined ? yield* localBaseRef(cwd) : undefined;
    const baseName =
      prBase ?? (localBase?.startsWith("origin/") ? localBase.slice("origin/".length) : undefined);
    const tips = yield* originTips(
      cwd,
      baseName === undefined || baseName === branch ? [branch] : [branch, baseName],
    );
    const upstream = yield* upstreamState(cwd, branch, state.head, tips.get(branch));
    if (upstream !== undefined) {
      cleared.upstream = upstream.upstream;
      if (upstream.ahead > 0) cleared.aheadUpstream = upstream.ahead;
    }
    const base = resolveBase(branch, prBase, localBase, tips);
    if (base === undefined) return yield* withHeadOnRemote(cwd, cleared);
    const baseTip = baseName === undefined ? undefined : tips.get(baseName);
    const named = isOid(baseTip) && isOid(state.head);
    const counts = named
      ? yield* countsBetween(cwd, baseTip, state.head)
      : yield* git(cwd, ["rev-list", "--left-right", "--count", `${base}...HEAD`]).pipe(
          Effect.map((out) => (out.status === 0 ? parseCounts(out.stdout) : undefined)),
        );
    const { behind, ahead } = counts ?? { behind: 0, ahead: 0 };
    cleared.base = base;
    cleared.behindBase = behind;
    cleared.aheadBase = ahead;
    cleared.conflicts =
      behind > 0 && ahead > 0
        ? named
          ? yield* conflictsBetween(cwd, baseTip, state.head)
          : yield* git(cwd, ["merge-tree", "--write-tree", base, "HEAD"]).pipe(
              Effect.option,
              Effect.map((trial) => Option.isSome(trial) && trial.value.status === 1),
            )
        : false;
    return yield* withHeadOnRemote(cwd, cleared);
  });

/**
 * The fetch is provably redundant: the local `origin/<base>` equals the base tip GraphQL just saw, and
 * the PR head (when known) equals the local `origin/<branch>`. Every miss fetches.
 */
export const fetchRedundant = (
  localBase: string | undefined,
  remoteBase: string,
  localHead: string | undefined,
  remoteHead: string | undefined,
): boolean => localBase === remoteBase && (remoteHead === undefined || localHead === remoteHead);

/** Fingerprint of the diff panel's input; refetch only when it moves. */
export const diffToken = (state: GitState): string =>
  stableHash([state.changesToken, state.base ?? "", state.behindBase, state.aheadBase]);

/** Fingerprint of the fields the PR panel must reflect; `updatedAt` catches comments and reviews. */
export const prFingerprint = (pr: PrStatus): string =>
  stableHash([
    pr.number,
    pr.state,
    String(pr.isDraft),
    pr.title,
    pr.baseRef ?? "",
    pr.headRefOid ?? "",
    pr.updatedAt ?? "",
    pr.checks,
  ]);

/** Swap in a PR and re-measure the rebase tier against its base; a timeout keeps `carried`'s tier. */
export const withPr = (
  cwd: string,
  state: GitState,
  pr: PrStatus | undefined,
  carried: GitState | undefined,
): Effect.Effect<GitState, never, Proc> =>
  Effect.gen(function* () {
    const { pr: _pr, ...rest } = state;
    const next: GitState = pr === undefined ? rest : { ...rest, pr };
    if (!next.repo || rebaseDone(pr, next.head)) return clearRebaseTier(next);
    return yield* fillRebase(cwd, next, pr?.baseRef).pipe(
      Effect.orElseSucceed(() => carryRebaseTier(next, carried)),
    );
  });

/** `next` with `carried`'s rebase tier (base, behind / ahead, conflicts, upstream); `next` as is without one. */
export const carryRebaseTier = (next: GitState, carried: GitState | undefined): GitState => {
  if (carried === undefined) return next;
  const tier: Partial<Mutable<GitState>> = {
    behindBase: carried.behindBase,
    aheadBase: carried.aheadBase,
    conflicts: carried.conflicts,
  };
  if (carried.base !== undefined) tier.base = carried.base;
  if (carried.upstream !== undefined) tier.upstream = carried.upstream;
  if (carried.aheadUpstream !== undefined) tier.aheadUpstream = carried.aheadUpstream;
  if (carried.headOnRemote !== undefined && carried.head === next.head)
    tier.headOnRemote = carried.headOnRemote;
  return { ...clearRebaseTier(next), ...tier };
};
