import { DOCS_ARCHIVE_KEEP_MAX, DOCS_ARCHIVE_KEEP_MIN, DOCS_ARCHIVE_MAX } from "./docs.ts";
import type { Settings } from "./settings.ts";

const dayCount = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;

export const DEFAULT_DOCS_ARCHIVE_PR_DAYS = 7;
export const DEFAULT_DOCS_ARCHIVE_WORKER_DAYS = 14;

/** When docs archive themselves, and how many archived docs a workspace keeps. */
export interface DocsArchivePolicy {
  /** Days after a PR merges or closes before the doc bound to it is archived. */
  readonly prDays: number;
  /** Days after a worker is archived before its docs bound to no PR are. */
  readonly workerDays: number;
  /** Archived docs kept; past it the earliest archived are purged. */
  readonly keep: number;
}

/** The docs' automatic archiving, with the defaults for what the user hasn't set. */
export const docsArchiveOf = (settings: Settings): DocsArchivePolicy => {
  const workspaces = settings.workspaces;
  const keep = workspaces?.docsArchiveKeep;
  return {
    prDays: dayCount(workspaces?.docsArchivePrDays, DEFAULT_DOCS_ARCHIVE_PR_DAYS),
    workerDays: dayCount(workspaces?.docsArchiveWorkerDays, DEFAULT_DOCS_ARCHIVE_WORKER_DAYS),
    keep:
      keep !== undefined &&
      Number.isInteger(keep) &&
      keep >= DOCS_ARCHIVE_KEEP_MIN &&
      keep <= DOCS_ARCHIVE_KEEP_MAX
        ? keep
        : DOCS_ARCHIVE_MAX,
  };
};
