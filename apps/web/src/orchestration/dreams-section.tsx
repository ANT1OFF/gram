import {
  DREAM_INSTRUCTIONS_MAX,
  type Dream,
  type DreamFileDiff,
  type DreamId,
  type DreamMerge,
  type DreamKind,
  type DreamMode,
  type ProjectId,
  type WorkspaceState,
  memoryUpdateModeOf,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Predicate from "effect/Predicate";
import { Check, GitMerge, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { agentLabel } from "@/agents/agent-display";
import { HarnessPreflightNote, useHarnessPreflight } from "@/agents/feature-preflight";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { DreamPreviewInput } from "@/api/types";
import { AgentFields, choiceModel, type AgentChoice } from "@/composer/agent-fields";
import { choiceFromModel } from "@/composer/default-choice";
import { FOLD, FoldSummary } from "@/components/fold-summary";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { useModelNames } from "@/composer/models";
import { formatDay } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { ExpandPresence, PresenceList, Shimmer } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";
import { useLayoutStore } from "@/stores/layout";
import { projectNameOf } from "@/settings/workspace-settings-model";
import { StatePill } from "@/thread/orchestration-cards";
import { diffStat, lineDiff } from "@/thread/orchestration-model";

import { ADMITTED_AGENTS } from "./admitted";
import {
  adoptState,
  conflictsToMerge,
  diffSides,
  withAskedMerges,
  dreamFailureText,
  dreamKindLabel,
  dreamStatus,
  mergeable,
  orderDreams,
  presentFileStatus,
  PER_REPO_DEFAULT,
  PER_REPO_MAX,
  perRepoOf,
  planLines,
  previewTotals,
  resolutionsToSend,
  reviewFiles,
  reviewSummary,
  sideLabel,
  startableScope,
  tokensText,
  type Resolutions,
  type ScopedPreview,
} from "./memory-model";
import { DreamRow, discardWarning } from "./dream-row";
import { InlineConfirm } from "./inline-confirm";
import { MemoryUpdatesPanel } from "./memory-updates-panel";
import { useDefaultModel } from "@/settings/model-slots";

const SECTION = "flex flex-col gap-2 rounded-(--radius-md) border border-edge bg-card/40 p-3";
const INPUT =
  "rounded-md border border-input bg-transparent px-2 text-reading outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";

const dateRange = (oldest: number | undefined, newest: number | undefined): string =>
  oldest === undefined || newest === undefined
    ? "—"
    : `${formatDay(oldest)} – ${formatDay(newest)}`;

function StartFlow({
  state,
  kind,
  onClose,
}: {
  state: WorkspaceState;
  kind: DreamKind;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<DreamMode>(
    kind === "dream" ? memoryUpdateModeOf(state.charter) : "review",
  );
  const modeLabel = useId();
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceId = state.workspace.id;
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const [perRepoText, setPerRepoText] = useState(String(PER_REPO_DEFAULT));
  const [includeMemory, setIncludeMemory] = useState(false);
  const [projectIds, setProjectIds] = useState<readonly ProjectId[]>(state.workspace.projectIds);
  const [ownModel, setOwnModel] = useState(false);
  const defaultModel = useDefaultModel();
  const nameOf = useModelNames([defaultModel]);
  const [choice, setChoice] = useState<AgentChoice>(() => choiceFromModel(defaultModel));
  const selectedModel = ownModel
    ? choice.model === ""
      ? undefined
      : choiceModel(choice)
    : defaultModel;
  const preflight = useHarnessPreflight(selectedModel, "dream", { requireVerified: true });
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const perRepoId = useId();
  const instructionsId = useId();
  const perRepo = perRepoOf(perRepoText);
  const importing = kind === "import";
  const scope: DreamPreviewInput | undefined = !importing
    ? { kind: "dream" }
    : perRepo === undefined || projectIds.length === 0
      ? undefined
      : { projectIds, perRepo, ...(includeMemory ? { includeMemory } : {}) };
  const query = useQuery({
    queryKey: ["dreams", workspaceId, "preview", scope ?? null, selectedModel ?? null],
    queryFn: async (): Promise<ScopedPreview> => {
      const counted = scope ?? {};
      return { scope: counted, preview: await api.previewDream(workspaceId, counted) };
    },
    enabled: scope !== undefined && selectedModel !== undefined && !preflight.blocked,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const preview = query.data?.preview;
  const stale = preview !== undefined && (query.isPlaceholderData || query.isFetching);
  const startable = startableScope({
    scope,
    shown: query.data,
    placeholder: query.isPlaceholderData,
    fetching: query.isFetching,
    failed: query.error !== null,
    busy,
    modelMissing: selectedModel === undefined || preflight.blocked,
  });
  const totals = preview === undefined ? undefined : previewTotals(preview);
  const plan = preview?.dream === undefined ? undefined : planLines(preview.dream);

  const start = () => {
    if (startable === undefined || selectedModel === undefined || preflight.blocked) return;
    setBusy(true);
    setError(undefined);
    api
      .startDream(workspaceId, {
        ...startable,
        kind,
        mode,
        model: selectedModel,
        ...(instructions.trim() === "" ? {} : { instructions: instructions.trim() }),
      })
      .then(async (dream) => {
        await queryClient.invalidateQueries({ queryKey: ["dreams", workspaceId] });
        onClose();
        if (dream.threadId !== undefined) {
          useLayoutStore.getState().openThread(dream.threadId);
          await navigate({ to: "/t/$threadId", params: { threadId: dream.threadId } });
        }
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
        setBusy(false);
      });
  };

  return (
    <div
      data-testid="dream-start"
      data-kind={kind}
      className="flex flex-col gap-3 rounded-(--radius-md) border border-edge bg-card p-3 text-meta"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-reading font-medium">
            {importing ? "Draft from past sessions" : "Update memory with options"}
          </h3>
          <p className="text-muted-foreground">
            {importing
              ? "Drafts memory from your past sessions in this workspace's repos. It runs as a thread you can watch and stop."
              : "Reads what happened since the last update (workers' reports, merges, answered questions and finished threads' recaps) and files what lasts, with a source for each change. Pick the model, steer it, or choose how this run lands."}
          </p>
          <p data-testid="dream-runs-rule" className="text-muted-foreground">
            One run at a time, in the agent's sandbox; it asks before anything it would normally ask
            about.
          </p>
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>

      {importing && (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium">Repos</legend>
            {state.workspace.projectIds.map((id) => (
              <label key={id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={projectIds.includes(id)}
                  onChange={(event) =>
                    setProjectIds(
                      event.target.checked
                        ? [...projectIds, id]
                        : projectIds.filter((each) => each !== id),
                    )
                  }
                />
                {projectNameOf(projects, id)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1">
            <label htmlFor={perRepoId} className="font-medium">
              Newest sessions per repo
            </label>
            <input
              id={perRepoId}
              data-testid="dream-per-repo"
              inputMode="numeric"
              className={cn(INPUT, "h-7 w-24 text-meta tabular-nums")}
              value={perRepoText}
              aria-invalid={perRepo === undefined}
              onChange={(event) => setPerRepoText(event.target.value)}
            />
            <span className={perRepo === undefined ? "text-destructive" : "text-muted-foreground"}>
              1 to {PER_REPO_MAX}; one memory update reads {PER_REPO_MAX} at most.
            </span>
          </div>
          <label className="flex max-w-xs items-start gap-2">
            <input
              type="checkbox"
              data-testid="dream-include-memory"
              className="mt-0.5 size-3.5 accent-primary"
              checked={includeMemory}
              onChange={(event) => setIncludeMemory(event.target.checked)}
            />
            <span>
              <span className="font-medium">Include Claude Code memory folders</span>
              <span className="block text-muted-foreground">
                Copies what Claude Code remembered for these folders in as seed material. Read only;
                never written back.
              </span>
            </span>
          </label>
        </div>
      )}

      <div data-testid="dream-preview" className="flex flex-col gap-2">
        {query.error ? (
          <p role="alert" className="text-destructive">
            {errorMessage(query.error)}
          </p>
        ) : preview === undefined ? (
          scope === undefined ? (
            <p className="text-muted-foreground">
              {importing
                ? "Tick a repo and give a limit to count what is there."
                : "Counting what this update would read."}
            </p>
          ) : preflight.blocked || selectedModel === undefined ? (
            <p className="text-muted-foreground">
              Choose an available agent for memory updates before counting inputs.
            </p>
          ) : (
            <Shimmer>Counting what is there…</Shimmer>
          )
        ) : (
          <>
            {stale && (
              <p role="status" data-testid="dream-preview-stale" className="text-muted-foreground">
                {scope === undefined
                  ? "These counts are of the last options that could be counted."
                  : "Updating the preview…"}
              </p>
            )}
            <div
              data-testid="dream-preview-counts"
              aria-busy={stale}
              className={cn(
                "flex flex-col gap-2 transition-opacity duration-(--dur-fast)",
                stale && "opacity-50",
              )}
            >
              {plan !== undefined && (
                <div data-testid="dream-plan" className="flex flex-col gap-0.5">
                  <p data-testid="dream-plan-reads">{plan.reads}</p>
                  {plan.more !== undefined && (
                    <p data-testid="dream-plan-more" className="text-muted-foreground">
                      {plan.more}
                    </p>
                  )}
                </div>
              )}
              {importing &&
                (preview.sources.length === 0 ? (
                  <p className="text-muted-foreground">
                    No past sessions were found for these repos.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[32rem] border-collapse text-left tabular-nums">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="py-1 pr-3 font-normal">Repo</th>
                          <th className="py-1 pr-3 font-normal">Agent</th>
                          <th className="py-1 pr-3 text-right font-normal">Sessions</th>
                          <th className="py-1 pr-3 font-normal">From – to</th>
                          <th className="py-1 text-right font-normal">Estimate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sources.map((source) => (
                          <tr
                            key={`${source.projectId}:${source.agent}:${source.cwd}`}
                            data-testid="dream-preview-source"
                            className="border-t border-border"
                          >
                            <td className="py-1 pr-3" title={source.cwd}>
                              {source.project}
                            </td>
                            <td className="py-1 pr-3">{agentLabel(source.agent)}</td>
                            <td className="py-1 pr-3 text-right">{source.sessions}</td>
                            <td className="py-1 pr-3">{dateRange(source.oldest, source.newest)}</td>
                            <td className="py-1 text-right">
                              {tokensText(source.estimatedTokens)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      {totals !== undefined && (
                        <tfoot>
                          <tr
                            data-testid="dream-preview-total"
                            className="border-t border-border-strong font-medium"
                          >
                            <td className="py-1 pr-3" colSpan={2}>
                              Total
                            </td>
                            <td className="py-1 pr-3 text-right">{totals.sessions}</td>
                            <td className="py-1 pr-3">{dateRange(totals.oldest, totals.newest)}</td>
                            <td className="py-1 text-right">
                              {tokensText(totals.estimatedTokens)}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                ))}
              <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                {importing && (
                  <li data-testid="dream-preview-worktrees">
                    Worktrees covered {preview.worktreesCovered}/{preview.worktreesTotal}
                  </li>
                )}
                <li>Closed threads still kept: {preview.closedThreadsKept}</li>
                {preview.archivedThreads !== undefined && (
                  <li>Archived transcripts: {preview.archivedThreads}</li>
                )}
                {preview.seedFiles !== undefined && (
                  <li>Claude Code memory files: {preview.seedFiles}</li>
                )}
              </ul>
              {preview.notes.length > 0 && (
                <ul
                  data-testid="dream-preview-notes"
                  aria-label="What this leaves out"
                  className="flex flex-col gap-0.5 rounded-(--radius-sm) border border-border px-2 py-1.5"
                >
                  {preview.notes.map((note) => (
                    <li key={note} className="flex items-start gap-1.5">
                      <TriangleAlert
                        aria-hidden
                        className="mt-0.5 size-icon-chip shrink-0 text-muted-foreground"
                      />
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-medium">Model</span>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            className="size-3.5 accent-primary"
            checked={!ownModel}
            onChange={() => setOwnModel(false)}
          />
          {defaultModel === undefined
            ? "No default model configured; choose one below"
            : `Your default: ${agentLabel(defaultModel.agent)} · ${nameOf(defaultModel)}`}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            data-testid="dream-own-model"
            className="size-3.5 accent-primary"
            checked={ownModel}
            onChange={() => setOwnModel(true)}
          />
          Choose one
        </label>
        <ExpandPresence open={ownModel}>
          <div data-testid="dream-model" className="flex flex-wrap items-center gap-2 pt-1">
            <AgentFields value={choice} onChange={setChoice} allowed={ADMITTED_AGENTS} />
          </div>
          <p className="pt-1 text-muted-foreground">
            A memory update runs on {ADMITTED_AGENTS.map(agentLabel).join(", ")}. The transcripts
            are read by the model you pick: through your gateway for a gateway profile, else where
            your sessions already went.
          </p>
        </ExpandPresence>
        <HarnessPreflightNote
          model={selectedModel}
          result={preflight.result}
          checking={preflight.checking}
          observation={preflight.observation}
          onRetry={preflight.recheck}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span id={modeLabel} className="font-medium">
          When this update is ready
        </span>
        <ModeChoice mode={mode} labelledBy={modeLabel} onChange={setMode} />
        <p
          role="status"
          data-testid="dream-mode-note"
          className="text-muted-foreground empty:hidden"
        >
          {mode === "auto"
            ? "Saved without another review or approval. If memory changed meanwhile, or the draft is invalid or can't be stored, nothing is saved. Earlier versions stay under History to restore."
            : ""}
        </p>
      </div>

      <label htmlFor={instructionsId} className="flex flex-col gap-1">
        <span className="font-medium">Steering (optional)</span>
        <textarea
          id={instructionsId}
          rows={2}
          maxLength={DREAM_INSTRUCTIONS_MAX}
          className={cn(INPUT, "resize-y py-1 text-meta")}
          value={instructions}
          placeholder="Focus on how the three repos deploy; ignore one-off debugging."
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>

      {error !== undefined && (
        <p role="alert" data-testid="dream-start-error" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-testid="dream-start-run"
          disabled={startable === undefined}
          onClick={start}
        >
          Start drafting
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {importing && totals !== undefined && !stale && (
          <span className="text-muted-foreground">
            Reads {totals.sessions} sessions, {tokensText(totals.estimatedTokens)}, on your own
            account.
          </span>
        )}
        {!importing && preview?.dream !== undefined && !stale && (
          <span className="text-muted-foreground">
            Reads {tokensText(preview.dream.estimatedTokens)}, on your own account.
          </span>
        )}
      </div>
    </div>
  );
}

const DIFF_LINE = {
  same: { mark: " ", className: "text-muted-foreground" },
  add: { mark: "+", className: "bg-success/10 text-success" },
  del: { mark: "−", className: "bg-destructive/10 text-destructive" },
} as const;

function MergeStatus({
  merge,
  error,
  onMerge,
}: {
  merge: DreamMerge | undefined;
  error: string | undefined;
  onMerge: () => void;
}) {
  const nameOf = useModelNames([merge?.model]);
  const on = merge === undefined ? "" : `${agentLabel(merge.model.agent)} · ${nameOf(merge.model)}`;
  if (error !== undefined || merge?.status === "failed") {
    return (
      <p
        role="alert"
        data-testid="dream-merge-status"
        data-status="failed"
        className="flex items-start gap-1.5 pl-5.5 text-destructive"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-icon-chip shrink-0" />
        <span className="min-w-0 flex-1">{error ?? merge?.error ?? "The merge failed."}</span>
        <Button size="xs" variant="ghost" data-testid="dream-merge-again" onClick={onMerge}>
          Retry
        </Button>
      </p>
    );
  }
  if (merge === undefined) return null;
  if (merge.status === "running") {
    return (
      <p
        role="status"
        data-testid="dream-merge-status"
        data-status="running"
        className="flex items-center gap-1.5 pl-5.5 text-muted-foreground"
      >
        <GitMerge aria-hidden className="size-icon-chip shrink-0 text-status-working" />
        <Shimmer>Merging on {on}…</Shimmer>
      </p>
    );
  }
  return (
    <p
      role="status"
      data-testid="dream-merge-status"
      data-status="done"
      className="flex items-center gap-1.5 pl-5.5 text-muted-foreground"
    >
      <Check aria-hidden className="size-icon-chip shrink-0 text-success" />
      <span className="min-w-0 flex-1">Merged on {on}: the diff is the merge.</span>
      <Button size="xs" variant="ghost" data-testid="dream-merge-again" onClick={onMerge}>
        Merge again
      </Button>
    </p>
  );
}

function FileDiff({
  file,
  side,
  onSide,
  onMerge,
  mergeError,
  settleable,
}: {
  file: DreamFileDiff;
  side: Resolutions[string] | undefined;
  onSide: (side: Resolutions[string]) => void;
  onMerge: () => void;
  mergeError: string | undefined;
  settleable: boolean;
}) {
  const [against, setAgainst] = useState<"baseline" | "current">("baseline");
  const name = useId();
  const sides = diffSides(file, against, side);
  const diff = useMemo(() => lineDiff(sides.before, sides.after), [sides.before, sides.after]);
  const conflict = file.status === "conflict";
  const canMerge = settleable && mergeable(file);
  const merged = side === "merged";
  const mergeReady = file.merge?.status === "done";
  return (
    <div
      data-testid="dream-diff"
      data-path={file.path}
      className="flex min-w-0 flex-1 flex-col gap-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h4 className="font-mono text-reading">{file.path}</h4>
        <StatePill state={presentFileStatus(file.status)} />
        <span className="text-meta text-muted-foreground tabular-nums">{diffStat(diff)}</span>
      </div>
      {conflict && (
        <fieldset
          data-testid="dream-conflict"
          className="flex flex-col gap-1.5 rounded-(--radius-md) border border-status-needs-mark/60 bg-card p-2 text-meta"
        >
          <legend className="sr-only">Which side of {file.path} to keep</legend>
          <p>
            The orchestrator wrote to this file after the update copied it, and the update changes
            it too. Adopting takes one of them whole, or a model's merge of both.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={name}
              data-testid="dream-take-output"
              className="size-3.5 accent-primary"
              checked={side === "output"}
              onChange={() => onSide("output")}
            />
            Take the update's, and lose what was written since
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={name}
              data-testid="dream-keep-current"
              className="size-3.5 accent-primary"
              checked={side === "current"}
              onChange={() => onSide("current")}
            />
            Keep memory as it is now, and leave the update's version of this file out
          </label>
          <label
            className={cn("flex items-center gap-2", !canMerge && "text-muted-foreground")}
            title={
              canMerge || !settleable
                ? undefined
                : "One side removed the file, so there is nothing to merge"
            }
          >
            <input
              type="radio"
              name={name}
              data-testid="dream-merge-both"
              className="size-3.5 accent-primary"
              disabled={!canMerge}
              checked={merged}
              onChange={() =>
                file.merge === undefined || file.merge.status === "failed"
                  ? onMerge()
                  : onSide("merged")
              }
            />
            Merge both: a model combines them, keeping what each side added
          </label>
          {merged && <MergeStatus merge={file.merge} error={mergeError} onMerge={onMerge} />}
          <div
            role="radiogroup"
            aria-label={
              merged && mergeReady ? "Compare the merge with" : "Compare the update's version with"
            }
            className="flex gap-1 pt-0.5"
          >
            {(
              [
                ["baseline", "what the update started from"],
                ["current", "memory now"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={against === value}
                onClick={() => setAgainst(value)}
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  against === value
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                Against {label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {merged && !mergeReady ? (
        <p data-testid="dream-merge-pending" className="text-meta text-muted-foreground">
          {file.merge?.status === "running"
            ? "The merged file shows here when the model is done."
            : "No merged file to show. Try again, or choose a side."}
        </p>
      ) : diff.length === 0 ? (
        <p className="text-meta text-muted-foreground">Empty on both sides.</p>
      ) : (
        <pre className="max-h-96 overscroll-contain overflow-auto rounded-sm bg-muted/40 py-1 font-mono text-meta">
          {diff.map((line, i) => {
            const display = DIFF_LINE[line.kind];
            return (
              <span key={i} className={cn("block px-2 whitespace-pre-wrap", display.className)}>
                {display.mark} {line.text}
              </span>
            );
          })}
        </pre>
      )}
    </div>
  );
}

function Review({
  workspaceId,
  dreamId,
  onClose,
}: {
  workspaceId: WorkspaceState["workspace"]["id"];
  dreamId: DreamId;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: ["dreams", workspaceId, "review", dreamId],
    queryFn: () => api.reviewDream(dreamId),
    retry: false,
  });
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [mergeErrors, setMergeErrors] = useState<Readonly<Record<string, string>>>({});
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshed, setRefreshed] = useState<string>();
  const [discarding, setDiscarding] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const stage = review.data !== undefined ? "loaded" : review.error ? "failed" : "loading";
  useEffect(() => {
    if (stage !== undefined) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [stage]);

  if (review.error) {
    return (
      <section ref={ref} data-testid="dream-review" className={SECTION}>
        <QueryError error={review.error} feature="The update's review" />
        <Button size="sm" variant="ghost" className="self-start" onClick={onClose}>
          Close
        </Button>
      </section>
    );
  }
  if (review.data === undefined) {
    return (
      <section ref={ref} data-testid="dream-review" className={SECTION}>
        <PanelMessage loading>Comparing the update's output with memory…</PanelMessage>
      </section>
    );
  }

  const data = review.data;
  const files = withAskedMerges(reviewFiles(data.files), asked, data.dream.model);
  const open = files.find((file) => file.path === selected) ?? files[0];
  const adopt = adoptState({ dream: data.dream, files }, resolutions);
  const failure = dreamFailureText(data.dream);

  const conflicts = files.filter((file) => file.status === "conflict");
  const settleable =
    data.dream.mode !== "auto" &&
    data.dream.status === "completed" &&
    data.dream.adoptedVersion === undefined;
  const toMerge = conflictsToMerge(files);

  const startMerges = (paths: readonly string[]) => {
    setResolutions((now) => ({
      ...now,
      ...Object.fromEntries(paths.map((path) => [path, "merged" as const])),
    }));
    setMergeErrors((now) =>
      Object.fromEntries(Object.entries(now).filter(([p]) => !paths.includes(p))),
    );
    setAsked((now) => new Set([...now, ...paths]));
    const settled = (path: string) =>
      setAsked((now) => new Set([...now].filter((candidate) => candidate !== path)));
    for (const path of paths) {
      api
        .mergeDreamConflict(dreamId, path)
        .then(() => review.refetch())
        .catch((e: unknown) => setMergeErrors((now) => ({ ...now, [path]: errorMessage(e) })))
        .finally(() => settled(path));
    }
  };

  const done = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dreams", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] }),
    ]);
    onClose();
  };
  const runAdopt = () => {
    setBusy(true);
    setError(undefined);
    setRefreshed(undefined);
    api
      .adoptDream(dreamId, {
        resolutions: resolutionsToSend(data, resolutions),
        ...(data.memoryVersion === undefined ? {} : { basedOn: data.memoryVersion }),
        ...(data.outputDigest === undefined ? {} : { outputDigest: data.outputDigest }),
        ...(data.memoryDigest === undefined ? {} : { memoryDigest: data.memoryDigest }),
      })
      .then(done)
      .catch(async (e: unknown) => {
        if (Predicate.isTagged(e, "InvalidState")) {
          await review.refetch();
          setResolutions({});
          setRefreshed(errorMessage(e));
        } else setError(errorMessage(e));
        setBusy(false);
      });
  };

  return (
    <section
      ref={ref}
      aria-label={data.dream.mode === "auto" ? "Update inspection" : "Update review"}
      data-testid="dream-review"
      className={cn(
        SECTION,
        "max-h-[calc(100dvh_-_var(--titlebar-height)_-_4.5rem)] min-h-0 scroll-mt-12 flex-col border-border-strong",
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-reading font-medium">
          {data.dream.mode === "auto" ? "Inspect" : "Review"} · {dreamKindLabel(data.dream)}
        </h3>
        <StatePill state={dreamStatus(data.dream)} />
        <span data-testid="dream-review-summary" className="text-meta text-muted-foreground">
          {reviewSummary(data.files)}
          {data.memoryVersion !== undefined && data.memoryVersion !== ""
            ? ` · against version ${data.memoryVersion}`
            : ""}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Close review"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div
        data-testid="dream-review-content"
        className="min-h-0 flex-1 overscroll-contain overflow-y-auto"
      >
        {failure !== undefined && (
          <p role="status" className="flex items-start gap-1.5 text-meta text-destructive">
            <TriangleAlert aria-hidden className="mt-0.5 size-icon-row shrink-0" />
            {failure} It can only be discarded.
          </p>
        )}
        {refreshed !== undefined && (
          <p
            role="alert"
            data-testid="dream-review-refreshed"
            className="flex items-start gap-1.5 rounded-(--radius-sm) border border-border-strong px-2 py-1.5 text-meta"
          >
            <TriangleAlert
              aria-hidden
              className="mt-0.5 size-icon-row shrink-0 text-muted-foreground"
            />
            <span>
              Nothing was adopted. {refreshed} What you see below is the review as it stands now:
              read it, choose again where it asks, then adopt.
            </span>
          </p>
        )}
        {data.report !== undefined && (
          <details open className={cn(FOLD, "text-meta")}>
            <FoldSummary className="text-muted-foreground">
              REPORT.md: what it merged, dropped and added, and why
            </FoldSummary>
            <pre
              data-testid="dream-report-text"
              className="mt-1 max-h-56 overscroll-contain overflow-auto rounded-sm bg-muted/40 p-2 font-mono whitespace-pre-wrap"
            >
              {data.report}
            </pre>
          </details>
        )}
        <div className="flex min-w-0 flex-col gap-3 md:flex-row">
          <ul aria-label="Files of the review" className="flex shrink-0 flex-col gap-0.5 md:w-64">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  data-testid="dream-file"
                  data-path={file.path}
                  data-status={file.status}
                  aria-current={open?.path === file.path ? "true" : undefined}
                  onClick={() => setSelected(file.path)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-1 text-left text-meta outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
                    open?.path === file.path && "bg-sidebar-row-active",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  <StatePill state={presentFileStatus(file.status)} className="text-meta" />
                  {file.status === "conflict" && resolutions[file.path] !== undefined && (
                    <span className="shrink-0 text-meta text-muted-foreground">
                      {sideLabel(resolutions[file.path]!)}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {files.length === 0 && (
              <li className="px-2 py-1 text-meta text-muted-foreground">
                The update wrote no files.
              </li>
            )}
            {conflicts.length > 1 && settleable && (
              <li className="px-2 pt-1">
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="dream-merge-all"
                  disabled={toMerge.length === 0}
                  title={
                    toMerge.length === 0
                      ? "Every conflict that can be merged has a merge"
                      : undefined
                  }
                  onClick={() => startMerges(toMerge)}
                >
                  Merge all conflicts
                </Button>
              </li>
            )}
          </ul>
          {open !== undefined && (
            <FileDiff
              key={open.path}
              file={open}
              side={resolutions[open.path]}
              onSide={(side) => setResolutions({ ...resolutions, [open.path]: side })}
              onMerge={() => startMerges([open.path])}
              mergeError={mergeErrors[open.path]}
              settleable={settleable}
            />
          )}
        </div>
        {error !== undefined && (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {data.dream.mode !== "auto" && (
          <Button
            size="sm"
            data-testid="dream-adopt"
            disabled={busy || !adopt.enabled}
            onClick={runAdopt}
          >
            Adopt as a new version
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          data-testid="dream-discard"
          aria-expanded={discarding}
          disabled={busy}
          onClick={() => setDiscarding(!discarding)}
        >
          Discard
        </Button>
        {adopt.reason !== undefined && failure === undefined && (
          <span data-testid="dream-adopt-reason" className="text-meta text-muted-foreground">
            {adopt.reason}
          </span>
        )}
      </div>
      <InlineConfirm
        open={discarding}
        label="Discard this update?"
        confirmLabel="Discard update"
        destructive
        busy={busy}
        onCancel={() => setDiscarding(false)}
        onConfirm={() => {
          setBusy(true);
          api
            .discardDream(dreamId)
            .then(done)
            .catch((e: unknown) => {
              setError(errorMessage(e));
              setBusy(false);
            });
        }}
      >
        {discardWarning()}
      </InlineConfirm>
    </section>
  );
}

function ModeChoice({
  mode,
  labelledBy,
  onChange,
}: {
  mode: DreamMode;
  labelledBy: string;
  onChange: (mode: DreamMode) => void;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-testid="dream-mode"
      className="flex flex-wrap items-center gap-x-4 gap-y-1"
    >
      <label className="flex items-center gap-1.5">
        <input
          type="radio"
          name={`dream-mode-${name}`}
          value="review"
          className="accent-primary"
          checked={mode === "review"}
          onChange={() => onChange("review")}
        />
        Let me review it first
      </label>
      <label className="flex items-center gap-1.5">
        <input
          type="radio"
          name={`dream-mode-${name}`}
          value="auto"
          className="accent-primary"
          checked={mode === "auto"}
          onChange={() => onChange("auto")}
        />
        Save it if it checks out
      </label>
    </div>
  );
}

function RunList({
  testId,
  title,
  dreams,
  now,
  running,
  reviewing,
  onReview,
  review,
}: {
  testId: string;
  title: string;
  dreams: readonly Dream[];
  now: number;
  running: boolean;
  reviewing: DreamId | undefined;
  onReview: (dream: DreamId | undefined) => void;
  review: (dream: DreamId) => ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-col gap-2.5">
      <h3 className="text-body-strong">
        {title}
        <span className="ms-1.5 font-normal text-muted-foreground tabular-nums">
          {dreams.length}
        </span>
      </h3>
      <ul className="flex flex-col gap-2.5">
        <PresenceList>
          {dreams.map((dream) => (
            <DreamRow
              key={dream.id}
              dream={dream}
              now={now}
              running={running}
              reviewing={reviewing === dream.id}
              onReview={() => onReview(reviewing === dream.id ? undefined : dream.id)}
            >
              {reviewing === dream.id && review(dream.id)}
            </DreamRow>
          ))}
        </PresenceList>
      </ul>
    </div>
  );
}

/**
 * The dreams of a workspace: start one or an import from a preview
 * of what it would read, watch or cancel the one that runs, and review a finished one before
 * adopting it, or select automatic adoption for just that run.
 */
export function DreamsSection({
  state,
  reviewing,
  starting,
  onStartingChange,
}: {
  state: WorkspaceState;
  /** The dream whose review is open, from the route's `?dream=`. */
  reviewing: DreamId | undefined;
  /** Which start flow is open; the Memory view's import offer opens it from outside. */
  starting: DreamKind | undefined;
  onStartingChange: (kind: DreamKind | undefined) => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const workspaceId = state.workspace.id;
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 30_000);
  const dreams = useQuery({
    queryKey: ["dreams", workspaceId, "list"],
    queryFn: () => api.listDreams(workspaceId),
    retry: false,
  });
  const review = (dream: DreamId | undefined) =>
    void navigate({
      to: "/w/$workspaceId/memory",
      params: { workspaceId },
      search: dream === undefined ? {} : { dream },
      replace: true,
    });
  useEffect(() => {
    if (starting !== undefined) ref.current?.scrollIntoView({ block: "nearest" });
  }, [starting]);
  const running = (dreams.data ?? []).some(
    (dream) => dream.status === "running" || dream.status === "pending",
  );

  const { ready, rest } = orderDreams(dreams.data ?? []);
  const reviewOf = (dream: DreamId) => (
    <Review
      key={dream}
      workspaceId={workspaceId}
      dreamId={dream}
      onClose={() => review(undefined)}
    />
  );

  return (
    <section
      ref={ref}
      aria-label="Memory updates"
      data-testid="dreams"
      className={cn(
        "thread-column flex flex-col gap-5",
        reviewing !== undefined && "[--thread-max-width:var(--settings-column-wide)]",
      )}
    >
      {dreams.data !== undefined && (
        <MemoryUpdatesPanel
          state={state}
          dreams={dreams.data}
          busy={running}
          onSeeChanges={(dream) => review(dream)}
        />
      )}
      {ready.length > 0 && (
        <RunList
          testId="dream-ready"
          title="Ready to review"
          dreams={ready}
          now={now}
          running={running}
          reviewing={reviewing}
          onReview={review}
          review={reviewOf}
        />
      )}
      <div data-testid="dream-form" className="flex flex-col gap-2">
        <div data-testid="dream-actions" className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="dream-now"
            disabled={running}
            title={running ? "One run per workspace at a time" : undefined}
            aria-expanded={starting === "dream"}
            onClick={() => onStartingChange(starting === "dream" ? undefined : "dream")}
          >
            Update with options…
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="dream-import"
            disabled={running}
            title={running ? "One run per workspace at a time" : undefined}
            aria-expanded={starting === "import"}
            onClick={() => onStartingChange(starting === "import" ? undefined : "import")}
          >
            Draft from past sessions
          </Button>
        </div>
        {running && (
          <p data-testid="dream-busy" className="text-body text-description">
            A run is under way; the next can start once it ends or you cancel it below.
          </p>
        )}
      </div>
      <ExpandPresence open={starting !== undefined}>
        {starting !== undefined && (
          <StartFlow
            key={starting}
            state={state}
            kind={starting}
            onClose={() => onStartingChange(undefined)}
          />
        )}
      </ExpandPresence>
      {dreams.error ? (
        <QueryError error={dreams.error} feature="Memory updates" />
      ) : dreams.data === undefined ? (
        <PanelMessage loading>Loading memory updates…</PanelMessage>
      ) : dreams.data.length === 0 ? (
        <p className="text-body text-description">
          No memory updates yet. Update now files what happened since memory was last changed.
        </p>
      ) : (
        rest.length > 0 && (
          <RunList
            testId="dream-history"
            title={ready.length > 0 ? "Other runs" : "Runs"}
            dreams={rest}
            now={now}
            running={running}
            reviewing={reviewing}
            onReview={review}
            review={reviewOf}
          />
        )
      )}
      {reviewing !== undefined && !(dreams.data ?? []).some((dream) => dream.id === reviewing) && (
        <Review
          key={reviewing}
          workspaceId={workspaceId}
          dreamId={reviewing}
          onClose={() => review(undefined)}
        />
      )}
    </section>
  );
}
