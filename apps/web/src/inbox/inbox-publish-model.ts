import type { Diff, PendingRequest } from "@gram/contracts";

const PUSH_OR_OPEN_PR =
  /(?:^|[;&|(]\s*)(?:git\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*push|gh\s+pr\s+create)\b/;

/**
 * Whether allowing `request` would publish its thread's branch, so the Inbox shows what it would
 * publish beside Allow: a shell approval whose command pushes or opens a pull request.
 */
export const publishesBranch = (request: PendingRequest): boolean => {
  if (request.kind !== "approval") return false;
  const command = request.input["command"];
  return typeof command === "string" && PUSH_OR_OPEN_PR.test(command.trim());
};

/** What a branch's diff against its base comes to, for one line: files, lines added and removed. */
export interface PublishSummary {
  /** `undefined` when the diff was too large to list, which `note` says. */
  readonly files: number | undefined;
  readonly additions: number;
  readonly deletions: number;
  /** The base it is compared with, less `origin/`: "main". */
  readonly base?: string | undefined;
  readonly note?: string | undefined;
}

/** `undefined` for a folder that isn't a repository, whose diff says nothing. */
export const publishSummaryOf = (diff: Diff): PublishSummary | undefined => {
  if (!diff.repo) return undefined;
  const files = diff.files ?? [];
  return {
    files: diff.files === undefined && diff.note !== undefined ? undefined : files.length,
    additions: files.reduce((n, file) => n + file.additions, 0),
    deletions: files.reduce((n, file) => n + file.deletions, 0),
    base: diff.base?.replace(/^origin\//, ""),
    note: diff.note,
  };
};
