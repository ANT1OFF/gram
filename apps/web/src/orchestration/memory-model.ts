import {
  DREAM_BUDGET_TOKENS_DEFAULT,
  DREAM_BUDGET_TOKENS_MAX,
  DREAM_BUDGET_TOKENS_MIN,
  type Dream,
  type DreamFailure,
  type DreamReport,
  type DreamFileDiff,
  type DreamFileStatus,
  type DreamPlan,
  type DreamResolution,
  type DreamReview,
  type DreamStatus,
  type ImportPreview,
  type MemoryFileInfo,
  type ModelRef,
} from "@gram/contracts";

import type { DreamPreviewInput } from "@/api/types";
import { canonicalJson } from "@/lib/canonical-json";
import { known, type StatePresentation } from "@/thread/orchestration-model";

// Pure logic behind the Memory view: the caps a file is held to, the open
// questions read out of `questions.md`, and what a dream's review lets the user do. No React.

/** The index every orchestrator session starts from, which has the smaller cap. */
const MEMORY_INDEX = "MEMORY.md";
export { QUESTIONS_FILE } from "@gram/contracts";
/**
 * The server's caps, held here too so a save that would be refused
 * never leaves.
 */
const MEMORY_INDEX_MAX_BYTES = 8 * 1024;
const MEMORY_FILE_MAX_BYTES = 32 * 1024;
const MEMORY_MAX_FILES = 40;

const memoryCapFor = (path: string): number =>
  path === MEMORY_INDEX ? MEMORY_INDEX_MAX_BYTES : MEMORY_FILE_MAX_BYTES;

/** The size the server will count: UTF-8 bytes, not characters. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Why a new file's name won't do, as the server would say it; `undefined` for one that will. */
export const memoryPathProblem = (
  path: string,
  existing: readonly string[] = [],
): string | undefined => {
  if (path === "") return "Name the file, e.g. decisions.md";
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.some((p) => p === "" || p === "." || p === "..")
  ) {
    return "A memory path is relative, e.g. repos/gram.md";
  }
  if (parts.length > 3) return "A memory file sits at most two folders deep";
  if (!path.endsWith(".md") || parts.at(-1) === ".md")
    return "Memory files are Markdown: end the name in .md";
  if (existing.includes(path)) return "There is a file of that name already";
  if (existing.length >= MEMORY_MAX_FILES) return `Memory holds at most ${MEMORY_MAX_FILES} files`;
  return undefined;
};

/** Whether `content` fits `path`'s cap, and the words for the meter under the editor. */
export const memorySize = (
  path: string,
  content: string,
): { readonly bytes: number; readonly cap: number; readonly over: boolean } => {
  const bytes = utf8Bytes(content);
  const cap = memoryCapFor(path);
  return { bytes, cap, over: bytes > cap };
};

/**
 * Whether a workspace's memory has anything learned in it: only the index, or nothing at all, is a
 * memory nobody has written to, which is when an import of past sessions is worth offering.
 */
export const memoryIsEmpty = (files: readonly Pick<MemoryFileInfo, "path">[]): boolean =>
  files.every((file) => file.path === MEMORY_INDEX);

// ---------------------------------------------------------------------------------------------
// questions.md: read by the parser the server writes it back with.

export { openQuestions, parseQuestions, type MemoryQuestion } from "@gram/contracts";

// ---------------------------------------------------------------------------------------------
// Dreams

const DREAM_STATUS: Record<DreamStatus, StatePresentation> = {
  pending: { label: "Starting", tone: "muted" },
  running: { label: "Running", tone: "working" },
  completed: { label: "Ready to review", tone: "needs" },
  failed: { label: "Failed", tone: "danger" },
  canceled: { label: "Cancelled", tone: "muted" },
};

/** A dream status's label and tone; one this build doesn't know reads as its own word (`known`). */
export const presentDreamStatus = (status: string): StatePresentation =>
  known(DREAM_STATUS, status) ?? { label: status, tone: "muted" };

/** A dream's status for its row: a completed one that was adopted says so instead of asking for a review. */
export const dreamStatus = (
  dream: Pick<DreamReport, "status" | "adoptedVersion" | "mode" | "adoptionFailure">,
): StatePresentation =>
  dream.status === "completed" && dream.adoptedVersion !== undefined
    ? { label: `Adopted as ${dream.adoptedVersion}`, tone: "success" }
    : dream.mode === "auto" && dream.status === "completed"
      ? dream.adoptionFailure === undefined
        ? { label: "Auto adoption pending", tone: "working" }
        : { label: "Auto adoption stopped", tone: "danger" }
      : presentDreamStatus(dream.status);

const FAILURE_TEXT: Record<DreamFailure, string> = {
  input_tampered: "An input file changed while the dream ran, so its output can't be trusted.",
  over_caps:
    "The output breaks memory's rules: a file is too large, there are too many, or a path isn't allowed.",
  missing_report: "The dream ended without a review report. Its candidate memory is incomplete.",
  no_output: "The dream ended without writing any output.",
  agent_error: "The agent stopped with an error before the dream finished.",
  canceled: "You cancelled it. What it had written so far is kept until you discard it.",
};

/** Why a dream can't be adopted, in words; a failed one that gives no reason still says so. */
export const dreamFailureText = (
  dream: Pick<Dream, "status" | "failure" | "adoptionFailure">,
): string | undefined => {
  if (dream.adoptionFailure !== undefined)
    return {
      refused:
        "Automatic adoption was refused because the run, candidate or current memory is no longer valid. Output is kept for inspection.",
      persistence_error:
        "Automatic adoption could not be confirmed. Check current memory and kept versions; output is retained.",
      interrupted:
        "Automatic adoption was interrupted. Check current memory and kept versions; output is retained and will not be applied again automatically.",
    }[dream.adoptionFailure];
  if (dream.failure !== undefined) {
    return known(FAILURE_TEXT, dream.failure) ?? `The dream failed (${dream.failure}).`;
  }
  if (dream.status === "failed") return "The dream failed, and didn't say why.";
  return dream.status === "canceled" ? FAILURE_TEXT.canceled : undefined;
};

export const dreamKindLabel = (dream: Pick<Dream, "kind">): string =>
  dream.kind === "import" ? "Import" : "Dream";

const dreamRunning = (dream: Pick<Dream, "status">): boolean =>
  dream.status === "running" || dream.status === "pending";

/** What can be done to a dream from its row. */
export const dreamActions = (
  dream: Pick<Dream, "status" | "adoptedVersion">,
): { readonly review: boolean; readonly cancel: boolean; readonly discard: boolean } => ({
  review: dream.status === "completed",
  cancel: dreamRunning(dream),
  discard: !dreamRunning(dream),
});

const FILE_STATUS: Record<DreamFileStatus, StatePresentation> = {
  added: { label: "Added", tone: "success" },
  changed: { label: "Changed", tone: "working" },
  removed: { label: "Removed", tone: "danger" },
  unchanged: { label: "Unchanged", tone: "muted" },
  conflict: { label: "Conflict", tone: "needs" },
};

/** A reviewed file's label and tone; a status this build doesn't know reads as its own word. */
export const presentFileStatus = (status: string): StatePresentation =>
  known(FILE_STATUS, status) ?? { label: status, tone: "muted" };

/** The review's files with the ones that need a decision first, then what changes, then what doesn't. */
export const reviewFiles = (files: readonly DreamFileDiff[]): DreamFileDiff[] => {
  const rank: Record<DreamFileStatus, number> = {
    conflict: 0,
    changed: 1,
    added: 1,
    removed: 1,
    unchanged: 2,
  };
  // A status with no rank sorts with the changes rather than making the comparison `NaN`.
  const rankOf = (file: DreamFileDiff) => known(rank, file.status) ?? 1;
  return files.toSorted((a, b) => rankOf(a) - rankOf(b) || a.path.localeCompare(b.path));
};

/** "2 changed · 1 added · 1 conflict": the review at a glance, in the order that matters. */
export const reviewSummary = (files: readonly Pick<DreamFileDiff, "status">[]): string => {
  const order: readonly DreamFileStatus[] = [
    "conflict",
    "changed",
    "added",
    "removed",
    "unchanged",
  ];
  const parts = order.flatMap((status) => {
    const count = files.filter((file) => file.status === status).length;
    if (count === 0) return [];
    return [`${count} ${status === "conflict" && count > 1 ? "conflicts" : status}`];
  });
  return parts.length === 0 ? "No files" : parts.join(" · ");
};

export type Resolutions = Readonly<Record<string, DreamResolution>>;

/** Whether a conflict has two versions a model can merge: one side removing the file leaves one. */
export const mergeable = (file: DreamFileDiff): boolean =>
  file.status === "conflict" && file.after !== undefined && file.current !== undefined;

/** The conflicts "Merge all" would start: mergeable, and with no merge running or done. */
export const conflictsToMerge = (files: readonly DreamFileDiff[]): string[] =>
  files
    .filter(
      (file) =>
        mergeable(file) && file.merge?.status !== "running" && file.merge?.status !== "done",
    )
    .map((file) => file.path);

/**
 * The review's files with each merge just asked for shown running, until the review says so itself:
 * an older merge still in the cached review must neither be adopted nor shown as the result.
 */
export const withAskedMerges = (
  files: readonly DreamFileDiff[],
  asked: ReadonlySet<string>,
  model: ModelRef,
): DreamFileDiff[] =>
  files.map((file) =>
    file.status === "conflict" && asked.has(file.path) && file.merge?.status !== "running"
      ? { ...file, merge: { status: "running", model: file.merge?.model ?? model, startedAt: 0 } }
      : file,
  );

/**
 * Whether Adopt may be pressed, and the sentence under it when it may not. Only a completed dream
 * that hasn't been adopted can be, and every conflict needs a side first: the server refuses an
 * adoption that leaves one open, so the button says so before the round trip. A merge counts as a
 * side only once it is done, since the server adopts the merged text it holds and nothing else.
 */
export const adoptState = (
  review: Pick<DreamReview, "dream" | "files">,
  resolutions: Resolutions,
): {
  readonly enabled: boolean;
  readonly unresolved: readonly string[];
  readonly reason?: string;
} => {
  const unresolved = review.files
    .filter((file) => file.status === "conflict" && resolutions[file.path] === undefined)
    .map((file) => file.path);
  if (review.dream.status !== "completed") {
    return { enabled: false, unresolved, reason: "Only a completed dream can be adopted." };
  }
  if (review.dream.adoptedVersion !== undefined) {
    return {
      enabled: false,
      unresolved,
      reason: `Adopted already, as version ${review.dream.adoptedVersion}.`,
    };
  }
  if (review.dream.mode === "auto") {
    return {
      enabled: false,
      unresolved,
      reason: "This run uses automatic adoption; its output is retained for inspection.",
    };
  }
  if (unresolved.length > 0) {
    return {
      enabled: false,
      unresolved,
      reason: `Choose a side for ${unresolved.join(", ")} first.`,
    };
  }
  const merging = review.files.filter(
    (file) =>
      file.status === "conflict" &&
      resolutions[file.path] === "merged" &&
      file.merge?.status !== "done",
  );
  if (merging.some((file) => file.merge?.status === "running")) {
    const paths = merging.filter((file) => file.merge?.status === "running").map((f) => f.path);
    return {
      enabled: false,
      unresolved,
      reason: `Wait for the merge of ${paths.join(", ")}, or choose a side.`,
    };
  }
  if (merging.length > 0) {
    return {
      enabled: false,
      unresolved,
      reason: `There is no finished merge of ${merging.map((f) => f.path).join(", ")}: merge again, or choose a side.`,
    };
  }
  if (review.files.every((file) => file.status === "unchanged")) {
    return { enabled: false, unresolved, reason: "This dream changes nothing." };
  }
  return { enabled: true, unresolved };
};

/** The sides to send: only those of files that are still conflicts, so a stale choice isn't passed on. */
export const resolutionsToSend = (
  review: Pick<DreamReview, "files">,
  resolutions: Resolutions,
): Resolutions =>
  Object.fromEntries(
    review.files.flatMap((file) => {
      const side = resolutions[file.path];
      return file.status === "conflict" && side !== undefined ? [[file.path, side] as const] : [];
    }),
  );

/**
 * The two texts a file's diff compares; a conflict can be read against memory as it is now, too.
 * With `merged` chosen and the merge done, the merged text is what is compared.
 */
export const diffSides = (
  file: DreamFileDiff,
  against: "baseline" | "current" = "baseline",
  side?: DreamResolution,
): { readonly before: string | undefined; readonly after: string | undefined } => ({
  before: against === "current" && file.status === "conflict" ? file.current : file.before,
  after:
    side === "merged" && file.status === "conflict" && file.merge?.status === "done"
      ? file.merge.merged
      : file.after,
});

/** A conflict's side, as the file list says it beside the file. */
export const sideLabel = (side: DreamResolution): string =>
  side === "output" ? "dream's" : side === "merged" ? "merged" : "current";

// ---------------------------------------------------------------------------------------------
// Import preview

export interface PreviewTotals {
  readonly sessions: number;
  readonly estimatedTokens: number;
  readonly oldest: number | undefined;
  readonly newest: number | undefined;
}

export const previewTotals = (preview: Pick<ImportPreview, "sources">): PreviewTotals => {
  const dates = (pick: (s: ImportPreview["sources"][number]) => number | undefined) =>
    preview.sources.flatMap((source) => {
      const value = pick(source);
      return value === undefined ? [] : [value];
    });
  const oldest = dates((s) => s.oldest);
  const newest = dates((s) => s.newest);
  return {
    sessions: preview.sources.reduce((sum, source) => sum + source.sessions, 0),
    estimatedTokens: preview.sources.reduce((sum, source) => sum + source.estimatedTokens, 0),
    oldest: oldest.length === 0 ? undefined : Math.min(...oldest),
    newest: newest.length === 0 ? undefined : Math.max(...newest),
  };
};

/** "~1.2M tokens": an order of magnitude, which is all the estimate is. */
export const tokensText = (tokens: number): string => {
  if (tokens >= 1_000_000) return `~${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `~${Math.round(tokens / 1_000)}k tokens`;
  return `~${tokens} tokens`;
};

/**
 * The most sessions one dream reads, which bounds the per-repo choice too.
 */
export const PER_REPO_MAX = 100;
export const PER_REPO_DEFAULT = 30;

/** A typed per-repo limit as the number to send; `undefined` for one the server would refuse. */
export const perRepoOf = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= PER_REPO_MAX ? value : undefined;
};

/** A dream's budget as the start screen offers it, in thousands of tokens. */
export const BUDGET_K_DEFAULT = DREAM_BUDGET_TOKENS_DEFAULT / 1000;

/** A typed budget in thousands of tokens as the tokens to send; `undefined` for one out of range. */
export const budgetOf = (raw: string): number | undefined => {
  const value = Number(raw) * 1000;
  return Number.isInteger(value) &&
    value >= DREAM_BUDGET_TOKENS_MIN &&
    value <= DREAM_BUDGET_TOKENS_MAX
    ? value
    : undefined;
};

/** `3 threads (≈40k tokens)`, or `nothing`. */
const threadsText = (threads: number, tokens: number): string =>
  threads === 0
    ? "nothing"
    : `${threads} ${threads === 1 ? "thread" : "threads"} (${tokensText(tokens)})`;

/**
 * What a dream's plan says on its start screen, as two sentences: what it reads and from where,
 * and what waits for the next dream. Plain words for the numbers the server counted.
 */
export const planLines = (
  plan: DreamPlan,
): { readonly reads: string; readonly backlog: string } => {
  const since = plan.fromStart
    ? "No dream has been adopted into this memory yet, so this one reads every thread from its start"
    : `Since the dream you last adopted (memory ${plan.memoryVersion})`;
  const what =
    plan.threads === 0
      ? "there is nothing new to read; the dream tidies memory alone"
      : `${plan.threads} ${plan.threads === 1 ? "thread" : "threads"}, ${plan.messages} new ${
          plan.messages === 1 ? "message" : "messages"
        }, ${tokensText(plan.estimatedTokens)}`;
  return {
    reads: `${since}: ${what}.`,
    backlog:
      plan.backlog.threads === 0
        ? `Backlog: nothing; everything new fits the budget of ${tokensText(plan.budgetTokens)}.`
        : `Backlog: ${threadsText(plan.backlog.threads, plan.backlog.estimatedTokens)} past the budget of ${tokensText(plan.budgetTokens)}, left for the next dream.`,
  };
};

/**
 * The suggestion under a workspace's newest adopted dream, when what was past its budget is waiting
 * and nothing runs: `undefined` otherwise. Older dreams' backlogs were read by the ones after.
 */
export const backlogSuggestion = (dreams: readonly Dream[]): string | undefined => {
  if (dreams.some((dream) => dream.status === "running" || dream.status === "pending")) {
    return undefined;
  }
  const newest = dreams.find((dream) => dream.adoptedVersion !== undefined);
  const backlog = newest?.backlog;
  if (backlog === undefined || backlog.threads === 0) return undefined;
  return `${threadsText(backlog.threads, backlog.estimatedTokens)} ${
    backlog.threads === 1 ? "was" : "were"
  } past the last dream's budget and wait for the next one.`;
};

/** A preview as it is held: beside the scope it was counted for, so the two can't come apart. */
export interface ScopedPreview {
  readonly scope: DreamPreviewInput;
  readonly preview: ImportPreview;
}

export interface DreamStartGate {
  /** What the form's options ask for now; `undefined` while they spell nothing the server takes. */
  readonly scope: DreamPreviewInput | undefined;
  /** The preview on screen. */
  readonly shown: ScopedPreview | undefined;
  /** It is an earlier scope's, kept up while this one's is counted. */
  readonly placeholder: boolean;
  readonly fetching: boolean;
  readonly failed: boolean;
  readonly busy: boolean;
  /** A model of the user's own was asked for and none is picked yet. */
  readonly modelMissing: boolean;
}

/**
 * The scope Start submits, or `undefined` while Start is off. It is the scope the preview on screen
 * was counted for, never the form's: the last preview stays up while the next is counted, and a
 * Start that read the form then would spend on sessions nobody was shown. So nothing starts over a
 * preview that is a placeholder, being refetched, failed, or of another scope than the form's.
 */
export const startableScope = (gate: DreamStartGate): DreamPreviewInput | undefined => {
  if (gate.busy || gate.modelMissing || gate.failed || gate.placeholder || gate.fetching) {
    return undefined;
  }
  if (gate.scope === undefined || gate.shown === undefined) return undefined;
  return canonicalJson(gate.shown.scope) === canonicalJson(gate.scope)
    ? gate.shown.scope
    : undefined;
};

/** Persisted pre-validation cards must not advertise seeded output as reviewable. */
export const verifiedDreamReport = (report: DreamReport): DreamReport =>
  report.status === "completed" &&
  report.adoptedVersion === undefined &&
  report.adoptionFailure === undefined &&
  !report.reportExcerpt?.trim()
    ? { ...report, status: "failed", failure: "missing_report", files: [] }
    : report;
