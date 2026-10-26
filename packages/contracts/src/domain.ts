import * as Schema from "effect/Schema";
import { LimitCleared, LimitWait, ThreadError } from "./agent-failure.ts";
import { BabysitState, HumanReviewNotice, ReviewNotice } from "./babysit.ts";
import { CodexHome } from "./codex-home.ts";
import { ChecksRollup, PrState } from "./git.ts";
import { LabelId, ProfileId, ProjectId, RequestId, ThreadId, TurnId, WorkspaceId } from "./ids.ts";
import {
  MessageOrigin,
  OrchestrationDigest,
  PrWatchSeen,
  SpawnedBy,
  ThreadRole,
} from "./orchestration.ts";
import { RunWatch } from "./run-watch.ts";
import { ReviewVerdict } from "./review.ts";
import { CompactionActivity, ThreadStatus } from "./thread-status.ts";

// ---------------------------------------------------------------------------------------------
// Agents, models, profiles

/** The agent CLIs Gram runs. */
export const AgentKind = Schema.Literals(["claude", "codex", "grok"]);
export type AgentKind = typeof AgentKind.Type;

/** Claude's permission modes. `dontAsk` is SDK-only but can arrive in a `setMode` suggestion. */
export const PermissionMode = Schema.Literals([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
  "dontAsk",
]);
export type PermissionMode = typeof PermissionMode.Type;

/** Reasoning efforts, lowest first; a gateway takes `max` only on `/responses` (see `gatewayEfforts`). */
export const ReasoningVariant = Schema.Literals(["none", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningVariant = typeof ReasoningVariant.Type;

/** Provider processing speed, independent of reasoning effort. */
export const SpeedMode = Schema.Literals(["standard", "fast"]);
export type SpeedMode = typeof SpeedMode.Type;

/** Last CLI report, not a promise of provider latency or entitlement. */
export const SpeedState = Schema.Struct({
  speed: Schema.Literals(["standard", "fast", "unknown"]),
  detail: Schema.optionalKey(Schema.String),
});
export type SpeedState = typeof SpeedState.Type;

/** What a thread runs on: agent + optional gateway profile + model + reasoning variant. */
export const ModelRef = Schema.Struct({
  agent: AgentKind,
  model: Schema.String,
  profileId: Schema.optionalKey(ProfileId),
  variant: Schema.optionalKey(ReasoningVariant),
  /** Absent: the CLI's own preference stands. A choice made in a picker sets it, Standard by default. */
  speed: Schema.optionalKey(SpeedMode),
});
export type ModelRef = typeof ModelRef.Type;
/** A model choice Gram can run: Grok Build takes no gateway, effort or Fast override. */
export const SupportedModelRef = ModelRef.check(
  Schema.makeFilter(
    (model) =>
      model.agent !== "grok" ||
      (model.profileId === undefined && model.variant === undefined && model.speed !== "fast") ||
      "Grok Build requires its local CLI login without gateway, effort or Fast overrides.",
  ),
);

/**
 * What an explicitly configured LiteLLM metadata catalog says beyond the ids in `/models`.
 * Every field is as declared there; an absent one is undeclared, not false.
 */
export const GatewayModelInfo = Schema.Struct({
  /** LiteLLM's mode: `chat`, `embedding`, `ocr`, `rerank`, `audio_speech`, … */
  mode: Schema.optionalKey(Schema.String),
  deprecated: Schema.optionalKey(Schema.Boolean),
  /** Refused to an ordinary key (403 "is restricted for this API key"). */
  restricted: Schema.optionalKey(Schema.Boolean),
  /** Takes function tools, which an agent can't work without. */
  tools: Schema.optionalKey(Schema.Boolean),
  reasoning: Schema.optionalKey(Schema.Boolean),
  /** Whether it takes `none`, `xhigh` and `max` as efforts. */
  noneEffort: Schema.optionalKey(Schema.Boolean),
  xhighEffort: Schema.optionalKey(Schema.Boolean),
  maxEffort: Schema.optionalKey(Schema.Boolean),
  /** Whether the gateway serves the provider's hosted web search on it. */
  webSearch: Schema.optionalKey(Schema.Boolean),
  maxInputTokens: Schema.optionalKey(Schema.Int),
});
export type GatewayModelInfo = typeof GatewayModelInfo.Type;

export const GatewayModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextWindow: Schema.optionalKey(Schema.Int),
  variants: Schema.optionalKey(Schema.Array(ReasoningVariant)),
  info: Schema.optionalKey(GatewayModelInfo),
});
export type GatewayModel = typeof GatewayModel.Type;

export const GatewayProfile = Schema.Struct({
  id: ProfileId,
  name: Schema.String,
  baseURL: Schema.String,
  /**
   * Reference to the stored key (Electron `safeStorage`); never the key itself. Server-owned: `""`
   * until `profiles.setKey` stores a key, then `profile:<id>`. A client-supplied value is ignored on
   * upsert; clients show "key set" when it's non-empty.
   */
  keyRef: Schema.String,
  models: Schema.Array(GatewayModel),
  /** Optional metadata endpoint explicitly configured by the user; never receives credentials. */
  modelCatalogURL: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.Boolean),
  /**
   * The model Gram's own small jobs run on, such as naming a thread: a cheap, quick one. A
   * gateway model id, not necessarily one of `models`; absent means {@link helperChoice}'s default.
   */
  helperModel: Schema.optionalKey(Schema.String),
  /** Reasoning effort sent with `helperModel`; absent leaves the model at its own default. */
  helperEffort: Schema.optionalKey(ReasoningVariant),
  /** Explicit helper data consent, bound to the exact endpoint the user reviewed. */
  helperContext: Schema.optionalKey(
    Schema.Struct({
      baseURL: Schema.String,
      scope: Schema.Literals(["opening", "conversation"]),
    }),
  ),
  /**
   * What a helper job falls back to when `helperModel` times out, is rate-limited or answers
   * garbage; absent means {@link helperFallbackChoice}'s default, `null` means no fallback.
   */
  helperFallback: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ model: Schema.String, effort: Schema.optionalKey(ReasoningVariant) }),
    ),
  ),
});
export type GatewayProfile = typeof GatewayProfile.Type;

/** A key or a recognised hostname never grants permission to send conversation context. */
export const helperContextAllowed = (profile: GatewayProfile, kind: string): boolean =>
  profile.helperContext?.baseURL === profile.baseURL &&
  (profile.helperContext.scope === "conversation" || kind === "title");

/** LiteLLM modes an agent can hold a conversation in. */
const CONVERSATION_MODES: ReadonlySet<string> = new Set(["chat", "responses"]);

/**
 * Ids that name a model no agent can talk to, for a gateway whose catalog doesn't say: embeddings,
 * rerankers, OCR, speech and image models, and tool-less `fusion` panels.
 */
const NOT_FOR_AGENTS =
  /embed|rerank|ocr|document-ai|whisper|transcri|tts|speech|realtime|image|dall-e|moderation|^fusion/i;

/**
 * Whether an agent can run on a gateway model, so the pickers offer it: a conversation model that
 * takes tools, isn't deprecated, and isn't restricted to privileged keys. Only what the gateway's
 * catalog declares counts; without one, the id decides.
 */
export const gatewayModelUsable = (model: GatewayModel): boolean => {
  const info = model.info;
  if (info === undefined) return !NOT_FOR_AGENTS.test(model.id);
  if (info.mode !== undefined && !CONVERSATION_MODES.has(info.mode)) return false;
  return info.deprecated !== true && info.restricted !== true && info.tools !== false;
};

/** A synthetic gateway profile on a reserved host, for tests and examples. */
export const EXAMPLE_GATEWAY = {
  id: "example" as ProfileId,
  name: "Example gateway",
  baseURL: "https://gateway.example.invalid/v1",
} as const;

/**
 * The model provider id Codex reaches a gateway under, so model refs read `gram/<model>`. A
 * thread's launch overrides use it, so they land on the same entry rather than beside it.
 */
export const GATEWAY_PROVIDER_ID = "gram";

/**
 * What helper jobs run on when the profile lists it and the user picked nothing else: a
 * recommended small model. Its name makes no data-residency or privacy promise.
 */
export const DEFAULT_HELPER = { model: "claude-haiku-5.5-eu", effort: "high" } as const satisfies {
  readonly model: string;
  readonly effort: ReasoningVariant;
};

/** A helper job's model, and the effort to ask for; an absent effort sends none. */
export interface HelperChoice {
  readonly model: string;
  readonly effort?: ReasoningVariant | undefined;
}

/**
 * The model a profile's helper jobs run on: the user's pick with their effort, else
 * {@link DEFAULT_HELPER} when the gateway lists it, else the first model. An effort is only ever
 * sent with a model known to take one, since Gemini answers the parameter with a 400.
 */
export const helperChoice = (
  profile: Pick<GatewayProfile, "models" | "helperModel" | "helperEffort">,
): HelperChoice | undefined => {
  if (profile.helperModel !== undefined) {
    return { model: profile.helperModel, effort: profile.helperEffort };
  }
  // Only what an agent could run: the first model is otherwise often an embedding model.
  const usable = profile.models.filter(gatewayModelUsable);
  if (usable.some((model) => model.id === DEFAULT_HELPER.model)) return DEFAULT_HELPER;
  const first = usable[0];
  return first === undefined ? undefined : { model: first.id };
};

/**
 * The fallback when the profile lists it and the user picked nothing else: Luna, on another
 * vendor's route, so an outage or cooldown doesn't stop the helpers. The user must
 * assess both providers before allowing context; model ids grant no residency guarantees.
 */
export const DEFAULT_HELPER_FALLBACK = {
  model: "gpt-6-luna",
  effort: "high",
} as const satisfies HelperChoice;

/**
 * The model a profile's helper jobs fall back to: the user's pick, none when they chose none, else
 * {@link DEFAULT_HELPER_FALLBACK} when the gateway lists it and it isn't the primary.
 */
export const helperFallbackChoice = (
  profile: Pick<GatewayProfile, "models" | "helperModel" | "helperEffort" | "helperFallback">,
): HelperChoice | undefined => {
  if (profile.helperFallback === null) return undefined;
  if (profile.helperFallback !== undefined) return profile.helperFallback;
  const primary = helperChoice(profile);
  return profile.models.some(
    (model) => model.id === DEFAULT_HELPER_FALLBACK.model && gatewayModelUsable(model),
  ) && primary?.model !== DEFAULT_HELPER_FALLBACK.model
    ? DEFAULT_HELPER_FALLBACK
    : undefined;
};

// A loop rather than `/\/+$/`: that pattern backtracks quadratically on a long run of slashes, and
// a base URL is whatever the user typed.
const normalURL = (url: string): string => {
  const text = url.trim().toLowerCase();
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end);
};

/** Whether two gateway addresses name the same endpoint, whatever their case or trailing slash. */
export const sameGatewayURL = (a: string, b: string): boolean => normalURL(a) === normalURL(b);

// ---------------------------------------------------------------------------------------------
// Projects, threads, labels

export const Label = Schema.Struct({
  id: LabelId,
  name: Schema.String,
  /** Hex colour literal. */
  color: Schema.String,
});
export type Label = typeof Label.Type;

/** Commands run in an isolated head-on-base checkout; absent command disables the local gate. */
const ProjectCheckCommand = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_384),
  Schema.makeFilter(
    (value) =>
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
      "Use a single line without control, invisible format or bidirectional characters.",
  ),
);
export const ProjectLocalCheck = Schema.Struct({
  command: Schema.optionalKey(ProjectCheckCommand),
  setup: Schema.optionalKey(ProjectCheckCommand),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
  ),
});
export type ProjectLocalCheck = typeof ProjectLocalCheck.Type;
export const DEFAULT_LOCAL_CHECK_TIMEOUT_MS = 90 * 60_000;

export const Project = Schema.Struct({
  id: ProjectId,
  /** Absolute path the user opened. */
  root: Schema.String,
  name: Schema.String,
  /** `git rev-parse --show-toplevel` of `root`; absent outside a repo. */
  repoRoot: Schema.optionalKey(Schema.String),
  localCheck: Schema.optionalKey(ProjectLocalCheck),
  /** Opaque identity of the complete stored recipe, including unreadable contents. */
  localCheckRevision: Schema.optionalKey(Schema.String),
  /** Read-only diagnostic; an invalid stored gate is unavailable, never OFF. */
  localCheckUnavailable: Schema.optionalKey(Schema.String),
  bookmarked: Schema.Boolean,
  /** Epoch ms; absent if never opened (e.g. bookmarked only). Drives the recents list. */
  lastOpenedAt: Schema.optionalKey(Schema.Number),
});
export type Project = typeof Project.Type;

export const CheckoutKind = Schema.Literals(["main", "worktree"]);
export type CheckoutKind = typeof CheckoutKind.Type;

export const Checkout = Schema.Struct({
  kind: CheckoutKind,
  path: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  /** Base branch the worktree was created from. */
  base: Schema.optionalKey(Schema.String),
  /** The main checkout's repo root for a worktree; equal to `path` or omitted for main. */
  repoRoot: Schema.optionalKey(Schema.String),
});
export type Checkout = typeof Checkout.Type;

export { CompactionActivity, ThreadStatus };

/** The status-derived sidebar groups. Pinned / Parked come from thread flags instead. */
export const SidebarGroup = Schema.Literals(["needsYou", "working", "idle", "settled"]);
export type SidebarGroup = typeof SidebarGroup.Type;

/**
 * Settled once ended or marked completed. Needs-you and working still win over `completedAt`, so a
 * completed thread that resumes and asks for approval isn't hidden. A stopped babysit needs you.
 */
export const sidebarGroup = ({
  status,
  completedAt,
  babysit,
}: {
  readonly status: ThreadStatus;
  readonly completedAt?: number | undefined;
  readonly babysit?: { readonly phase: BabysitState["phase"] } | undefined;
}): SidebarGroup => {
  if (babysit?.phase === "stopped" && (status === "idle" || status === "cold")) return "needsYou";
  switch (status) {
    case "needsApproval":
    case "needsInput":
    case "error":
      return "needsYou";
    case "starting":
    case "running":
      return "working";
    case "ended":
      return "settled";
    case "idle":
    case "cold":
      return completedAt === undefined ? "idle" : "settled";
  }
};

/** At most one label per thread; an array so the cap can be lifted without a wire change. */
export const ThreadLabels = Schema.Array(LabelId).check(Schema.isMaxLength(1));
export type ThreadLabels = typeof ThreadLabels.Type;

/** A PR the thread follows (`pr_bind`); drives the sidebar badge and CI monitoring. */
/** The most pull requests a merge intent waits on. */
export const MERGE_AFTER_MAX = 8;

/**
 * `merge_when_ready`: squash (or merge, or rebase) the bound PR once the review bot's approval is on
 * its exact head, its required checks are green and GitHub would merge it, pinned to that head.
 * `after` and `hold` keep it waiting beyond that, which is how an orchestrator keeps a merge off
 * `main` until a release has shipped what is there.
 */
export const MergeIntent = Schema.Struct({
  method: Schema.Literals(["squash", "merge", "rebase"]),
  /** Pull requests that must have merged first. */
  after: Schema.optionalKey(
    Schema.Array(Schema.Struct({ repo: Schema.String, number: Schema.Int })).check(
      Schema.isMaxLength(MERGE_AFTER_MAX),
    ),
  ),
  /** Held until cleared, and why. */
  hold: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /**
   * `agent` when the hold waits on an agent's work (a review bot's re-review, another worker's
   * change). Absent: it waits on a person.
   */
  holdWaitsOn: Schema.optionalKey(Schema.Literal("agent")),
  /** Who set `after` and `hold`: a worker can't lift what its orchestrator set. */
  heldBy: Schema.optionalKey(Schema.Literals(["orchestrator", "thread"])),
  /**
   * `autonomy`: no card was raised, since the workspace's autonomy is `full`, which is asked again
   * before merging. `user`: the user approved it on a card.
   */
  allowedBy: Schema.Literals(["user", "autonomy"]),
  /**
   * Per-call user approval provenance. An intent without it cannot waive maintenance cards.
   * Written only by the merge tool after an actual card, never inferred from binding or ownership.
   */
  userAuthorization: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      callerId: ThreadId,
      threadId: ThreadId,
      workspaceId: WorkspaceId,
      repo: Schema.String,
      number: Schema.Int,
      method: Schema.Literals(["squash", "merge", "rebase"]),
      /** Maintenance was delegated; recheck that delegation at launch. */
      reused: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  /** Epoch ms. */
  setAt: Schema.Number,
  /** The head a merge was refused on; it is tried again once the head moves. */
  failedOn: Schema.optionalKey(Schema.String),
});
export type MergeIntent = typeof MergeIntent.Type;

/** The most people's reviews a `MonitorMark` remembers; older ones fall off the front. */
export const MONITOR_MARK_REVIEWS_MAX = 32;

/**
 * What a PR's monitors last saw of it, kept with the binding so the first look after a restart
 * compares against it: without it, that look is only a baseline, and a CI settle, a bot round or a
 * person's review that landed while the app was down would never be told.
 */
export const MonitorMark = Schema.Struct({
  head: Schema.optionalKey(Schema.String),
  /** The CI monitor's rollup (every check). */
  ci: Schema.optionalKey(ChecksRollup),
  /** The review monitor's: the required checks, the verdict on `head` and the merge state. */
  checks: Schema.optionalKey(ChecksRollup),
  verdict: Schema.optionalKey(ReviewVerdict),
  mergeState: Schema.optionalKey(Schema.String),
  /** The latest bot summary review, whose successor is a new round. */
  reviewId: Schema.optionalKey(Schema.String),
  /** The reviews were read, so no `reviewId` means the bot hadn't reviewed yet. */
  reviewsRead: Schema.optionalKey(Schema.Boolean),
  /** People's reviews already seen, by id, newest last. */
  humanReviews: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(MONITOR_MARK_REVIEWS_MAX)),
  ),
});
export type MonitorMark = typeof MonitorMark.Type;

/** The most PRs one PR may be declared to depend on. */
export const MAX_PR_DEPENDENCIES = 4;

/**
 * A PR the bound one depends on (`depends_on`): its thread is woken when it merges, is closed or
 * gets a new push, and `merge_when_ready` waits for it to merge first unless `mergeAfter` is false.
 */
export const PrDependency = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  number: Schema.Int,
  /** Who declared it: a worker can't drop, or stop merging after, what its orchestrator declared. */
  setBy: Schema.Literals(["orchestrator", "thread"]),
  /** Epoch ms. */
  setAt: Schema.Number,
  /** `merge_when_ready` needn't wait for it. */
  mergeAfter: Schema.optionalKey(Schema.Literal(false)),
  /** What its watch last saw, which its next events are measured from; absent before a look. */
  seen: Schema.optionalKey(PrWatchSeen),
});
export type PrDependency = typeof PrDependency.Type;

export const BoundPr = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  number: Schema.Int,
  /** Queue a message into the thread when checks settle. */
  monitor: Schema.Boolean,
  /**
   * Queue one structured review notice when a bot round lands or the verdict or merge state changes;
   * a CI settle joins the same notice.
   */
  reviewMonitor: Schema.optionalKey(Schema.Boolean),
  /** What its monitors last saw; absent until one has looked. */
  seen: Schema.optionalKey(MonitorMark),
  /** Merge it once it is ready (`merge_when_ready`); absent when nobody asked. */
  mergeWhenReady: Schema.optionalKey(MergeIntent),
  /** The PRs it depends on, in the order they were declared; absent when none was. */
  dependsOn: Schema.optionalKey(
    Schema.Array(PrDependency).check(Schema.isMaxLength(MAX_PR_DEPENDENCIES)),
  ),
});
export type BoundPr = typeof BoundPr.Type;

/** The dependencies `merge_when_ready` waits on: those it wasn't told it needn't. */
export const mergeAfterDependencies = (bound: BoundPr): ReadonlyArray<PrDependency> =>
  (bound.dependsOn ?? []).filter((dependency) => dependency.mergeAfter !== false);

/** The most workflow runs a thread watches at once; each one is a lookup every poll. */
export const MAX_RUN_WATCHES = 8;

/** A GitHub Actions run a thread waits on (`run_monitor`): one message into it when the run completes. */
export { RunWatch } from "./run-watch.ts";

/** The most PRs a thread follows beside `boundPr`; each one is a lookup in every GitHub sweep. */
export const MAX_EXTRA_PRS = 8;

/** Whether two bindings name the same PR; GitHub treats `owner/repo` case-insensitively. */
export const samePr = (
  a: Pick<BoundPr, "repo" | "number">,
  b: Pick<BoundPr, "repo" | "number">,
): boolean => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();

/**
 * A PR the user took out of the thread's PR strip. It stays bound or followed; only its row goes, and
 * it comes back by itself when something new needs the user (the web app's `prAttentionOf`).
 */
export const HiddenPr = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  number: Schema.Int,
  /** The PR's state when it was hidden; an open PR hidden while closed or merged was reopened. */
  state: Schema.optionalKey(PrState),
  /** What already needed the user when it was hidden, which doesn't bring the row back. */
  seen: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(8))),
});
export type HiddenPr = typeof HiddenPr.Type;

/** The most hidden PRs a thread keeps; hiding one more forgets the oldest. */
export const MAX_HIDDEN_PRS = 16;

export const CompletedReason = Schema.Literals(["agent", "user", "prMerged"]);
export type CompletedReason = typeof CompletedReason.Type;

/** A PR by its badge's number and URL, which also names its repo. */
export const PrMark = Schema.Struct({ number: Schema.Int, url: Schema.String });
export type PrMark = typeof PrMark.Type;

/** Whether two marks name the same PR; GitHub treats URLs case-insensitively. */
export const samePrMark = (a: PrMark, b: PrMark): boolean =>
  a.number === b.number && a.url.toLowerCase() === b.url.toLowerCase();

/** The most merges a thread remembers having settled on; past it the oldest are forgotten. */
export const MAX_SETTLED_MERGES = 32;

/**
 * What a thread looked like when it was last seen completed with a merge in: kept after work resumes
 * and clears the completion, so the same merges never complete it again. `head` and `changesToken`
 * are the checkout's then, what work since is measured from.
 */
export const MergeSettle = Schema.Struct({
  /**
   * Every merge the thread has settled on or seen while completed, oldest first, rebinds included;
   * a merge not among them completes the thread again.
   */
  merged: Schema.Array(PrMark).check(Schema.isMaxLength(MAX_SETTLED_MERGES)),
  head: Schema.optionalKey(Schema.String),
  changesToken: Schema.optionalKey(Schema.String),
});
export type MergeSettle = typeof MergeSettle.Type;

/** Persisted explicit workspace switch; the prior owner is never inferred from the requested model. */
export const SessionSwitch = Schema.Struct({
  id: Schema.String,
  previous: ModelRef,
  target: ModelRef,
  mode: PermissionMode,
  phase: Schema.Literals(["checkpoint", "retry", "stopping", "starting", "ready", "failed"]),
  oldExited: Schema.Boolean,
  /** Release proof for this exact id; a closed pre-spawn path is distinct from actual EXIT. */
  targetRelease: Schema.optionalKey(Schema.Literals(["notStarted", "exited"])),
  /** Admission proof belongs to the previous failed attempt, never to this new target. */
  retryFrom: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, release: Schema.Literals(["notStarted", "exited"]) }),
  ),
  checkpointTurnId: Schema.optionalKey(TurnId),
  detail: Schema.optionalKey(Schema.String),
});
export type SessionSwitch = typeof SessionSwitch.Type;

export const Thread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  /** The user renamed it; helper-LLM titles must not overwrite. */
  userNamed: Schema.Boolean,
  /**
   * The agent named it (`set_title`), so helper-LLM titles must not overwrite that either. Recorded
   * rather than read off the text: the agent can pick the very words the helper did, and a second
   * helper title would then replace the agent's.
   */
  agentNamed: Schema.optionalKey(Schema.Boolean),
  model: ModelRef,
  speedState: Schema.optionalKey(SpeedState),
  sessionSwitch: Schema.optionalKey(SessionSwitch),
  mode: PermissionMode,
  checkout: Checkout,
  /**
   * Another worktree of the same repo the agent moved into mid-session, followed while
   * `agents.followWorktreeMoves` is on. Panels and git state use it; resume still uses `checkout`.
   */
  currentCheckout: Schema.optionalKey(Checkout),
  /** The agent's own session id (Claude transcript id), used for resume. */
  agentSessionId: Schema.optionalKey(Schema.String),
  /**
   * The session has an id but has never received a message, so there is no transcript to resume:
   * it opens fresh under the same id (a fork re-forks its source). Absent once a message was sent.
   */
  agentSessionUnused: Schema.optionalKey(Schema.Boolean),
  /**
   * Codex: the `CODEX_HOME` the agent session lives in, recorded when it first opens. Absent for
   * other agents, and for a session resumed by id without one, which lives in the user's own.
   */
  codexHome: Schema.optionalKey(CodexHome),
  /** How the last failed turn failed; cleared when a later turn completes. */
  lastError: Schema.optionalKey(ThreadError),
  /** Waiting out a provider limit, to resume on its own; cleared when it resumes or is cancelled. */
  limitWait: Schema.optionalKey(LimitWait),
  /**
   * The last limit wait ended early, as fresh data showed the limit no longer applied; cleared
   * when another wait begins or the user sends their own input.
   */
  limitCleared: Schema.optionalKey(LimitCleared),
  labels: ThreadLabels,
  pinned: Schema.Boolean,
  parked: Schema.Boolean,
  /** Older persisted forks may only identify the source conversation, not its Gram thread. */
  forkedFrom: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.optionalKey(ThreadId),
      agentSessionId: Schema.optionalKey(Schema.String),
      codexHome: Schema.optionalKey(CodexHome),
    }),
  ),
  /** Raised by the user or the `set_unread` app tool; cleared when the thread is viewed. */
  unread: Schema.Boolean,
  /** Epoch ms the work was marked done and ready for review. */
  completedAt: Schema.optionalKey(Schema.Number),
  /** Who or what marked it completed; present only while `completedAt` is set. */
  completedReason: Schema.optionalKey(CompletedReason),
  /** Present once a merge has completed the thread; it outlives that completion. */
  settledMerge: Schema.optionalKey(MergeSettle),
  boundPr: Schema.optionalKey(BoundPr),
  /**
   * Further PRs the thread follows beside `boundPr`, in the order they were bound. They get a badge
   * and CI watching only: the PR panel, merge actions, babysit mode and the review monitor stay with
   * `boundPr`, and merging one never completes the thread. Capped in the schema too, so a stored
   * or imported thread can't widen every GitHub sweep past `MAX_EXTRA_PRS`.
   */
  extraPrs: Schema.optionalKey(Schema.Array(BoundPr).check(Schema.isMaxLength(MAX_EXTRA_PRS))),
  /** Workflow runs the thread waits on, oldest first; each goes once its run completes. */
  runWatches: Schema.optionalKey(Schema.Array(RunWatch).check(Schema.isMaxLength(MAX_RUN_WATCHES))),
  /** PRs kept out of the PR strip (`pr.hide`), oldest first; bindings are untouched. */
  hiddenPrs: Schema.optionalKey(Schema.Array(HiddenPr).check(Schema.isMaxLength(MAX_HIDDEN_PRS))),
  /** Babysit mode on the bound PR (`thread.setBabysit`); absent while off. */
  babysit: Schema.optionalKey(BabysitState),
  /**
   * The PR head `pr_request_rereview` last posted its command on without a card. On the thread, not
   * in `babysit`, because `auto` mode waives that card with no babysit state to keep it in.
   */
  rereviewRequestedOn: Schema.optionalKey(Schema.String),
  /** Folders beyond the checkout that the user granted the agent (`request_directory`). */
  additionalDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Worktrees in other repos that a worker was given for a change spanning them, on its feature's
   * branch. The thread's git state, checkpoints and diff follow `checkout` alone; these are held so
   * no other thread is opened on them and so closing the worker can release them.
   */
  extraCheckouts: Schema.optionalKey(Schema.Array(Checkout)),
  /** Branches observed in held worker worktrees, scoped by path; checkout moves grant no ownership. */
  ownedBranches: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, branch: Schema.String })),
  ),
  /** What the thread is for the server beyond a plain conversation; absent for a plain thread. */
  role: Schema.optionalKey(ThreadRole),
  /**
   * The workspace the thread belongs to: the one an orchestrator runs, or the one a worker was
   * spawned in or joined (`thread.joinWorkspace`, `adopt_thread`). A worker keeps it when its
   * orchestrator goes, so the next orchestrator there can see it; `thread.detach` clears it.
   */
  workspaceId: Schema.optionalKey(WorkspaceId),
  /**
   * The orchestrator that spawned this worker, or took it on when it joined; cleared by
   * `thread.detach` or when it goes.
   */
  spawnedBy: Schema.optionalKey(SpawnedBy),
  /** Position in the manually ordered sidebar; set by `threads.reorder`, absent until placed. */
  sortOrder: Schema.optionalKey(Schema.Number),
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** Epoch ms. */
  lastActivityAt: Schema.Number,
  /**
   * Epoch ms the user last moved away from the thread, having had it in the focused pane of a
   * focused window. Absent until they first have; `recapDue` reads it.
   */
  lastViewedAt: Schema.optionalKey(Schema.Number),
});
export type Thread = typeof Thread.Type;

/**
 * Why a PR tool or action refuses an orchestrator's own thread. It drives many PRs through its
 * workers, and the one its checkout's branch has is none of them.
 */
export const ORCHESTRATOR_HAS_NO_PR =
  "An orchestrator follows no pull request of its own: each of its workers carries its own. Read one with pr_status and the worker's threadId.";

/**
 * `thread` with each PR it follows listed once: an extra that is also `boundPr` goes, and so does a
 * repeated extra. Every write of a thread passes through this, so no writer of `boundPr` (bind,
 * promote, babysit, the review monitor, PR create and checkout) can leave one PR with two rows, and
 * none can leave an orchestrator following a PR, watching one or babysitting one.
 */
export const normalizeThreadPrs = (thread: Thread): Thread => {
  if (thread.role === "orchestrator") {
    const { boundPr, extraPrs, babysit, rereviewRequestedOn, ...rest } = thread;
    const held = [boundPr, extraPrs, babysit, rereviewRequestedOn].some((v) => v !== undefined);
    return held ? rest : thread;
  }
  const extras = thread.extraPrs;
  if (extras === undefined) return thread;
  const kept = extras.filter(
    (extra, index) =>
      !(thread.boundPr !== undefined && samePr(thread.boundPr, extra)) &&
      extras.findIndex((other) => samePr(other, extra)) === index,
  );
  if (kept.length === extras.length) return thread;
  const { extraPrs, ...rest } = thread;
  void extraPrs;
  return kept.length === 0 ? rest : { ...rest, extraPrs: kept };
};

export const Attachment = Schema.Struct({
  path: Schema.String,
  name: Schema.optionalKey(Schema.String),
  mediaType: Schema.optionalKey(Schema.String),
});
export type Attachment = typeof Attachment.Type;

/**
 * Gram asking an idle thread's agent to compact (`/compact`) before its prompt cache expires: the
 * transcript shows this rather than a message from the user.
 */
export const IdleCompactNotice = Schema.Struct({
  kind: Schema.Literal("idleCompact"),
  /** The context it starts from, in tokens. */
  contextTokens: Schema.Int,
  /** The workspace whose setting asked for it, so the transcript can link to that setting. */
  workspaceId: Schema.optionalKey(WorkspaceId),
});
export type IdleCompactNotice = typeof IdleCompactNotice.Type;

/** Who wrote a user-role input: the user at a Gram surface, or Gram itself (a notice). */
export const InputAuthor = Schema.Literals(["user", "server"]);
export type InputAuthor = typeof InputAuthor.Type;

export const UserInput = Schema.Struct({
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  /** A structured notice the transcript renders as a card; the agent reads `text`. */
  notice: Schema.optionalKey(
    Schema.Union([ReviewNotice, HumanReviewNotice, OrchestrationDigest, IdleCompactNotice]),
  ),
  /** Set when another thread sent the message (`send_message`); the transcript names the sender. */
  origin: Schema.optionalKey(MessageOrigin),
  /**
   * The note on Waiting on you the server added at the end of `text` as it sent the message
   * (`waitNoteText`), which the transcript shows as a line of its own. Never set by a client.
   */
  waitNote: Schema.optionalKey(Schema.String),
  /**
   * Who wrote it, as the server establishes: `user` for what the user typed into a Gram surface,
   * `server` for a notice Gram wrote. Absent for another thread's message (`origin`) and for a
   * notice queued by its key alone, which is Gram's. Only `user` is ever taken as the user's own words.
   */
  author: Schema.optionalKey(InputAuthor),
});
export type UserInput = typeof UserInput.Type;

// ---------------------------------------------------------------------------------------------
// Permission updates (mirrors the Claude Agent SDK's `PermissionUpdate`)

export const PermissionBehavior = Schema.Literals(["allow", "deny", "ask"]);
export type PermissionBehavior = typeof PermissionBehavior.Type;

export const PermissionUpdateDestination = Schema.Literals([
  "userSettings",
  "projectSettings",
  "localSettings",
  "session",
  "cliArg",
]);
export type PermissionUpdateDestination = typeof PermissionUpdateDestination.Type;

export const PermissionRuleValue = Schema.Struct({
  toolName: Schema.String,
  ruleContent: Schema.optionalKey(Schema.String),
});
export type PermissionRuleValue = typeof PermissionRuleValue.Type;

const rulesUpdate = <const T extends "addRules" | "replaceRules" | "removeRules">(type: T) =>
  Schema.Struct({
    type: Schema.Literal(type),
    rules: Schema.Array(PermissionRuleValue),
    behavior: PermissionBehavior,
    destination: PermissionUpdateDestination,
  });

const directoriesUpdate = <const T extends "addDirectories" | "removeDirectories">(type: T) =>
  Schema.Struct({
    type: Schema.Literal(type),
    directories: Schema.Array(Schema.String),
    destination: PermissionUpdateDestination,
  });

export const PermissionUpdate = Schema.Union([
  rulesUpdate("addRules"),
  rulesUpdate("replaceRules"),
  rulesUpdate("removeRules"),
  Schema.Struct({
    type: Schema.Literal("setMode"),
    mode: PermissionMode,
    destination: PermissionUpdateDestination,
  }),
  directoriesUpdate("addDirectories"),
  directoriesUpdate("removeDirectories"),
]);
export type PermissionUpdate = typeof PermissionUpdate.Type;

// ---------------------------------------------------------------------------------------------
// Pending requests and answers

export const ApprovalScope = Schema.Literals(["once", "session", "always"]);
export type ApprovalScope = typeof ApprovalScope.Type;

const requestFields = {
  id: RequestId,
  /** The tool call this request gates, when the agent exposes one. */
  toolUseId: Schema.optionalKey(Schema.String),
};

export const ApprovalRequest = Schema.Struct({
  kind: Schema.Literal("approval"),
  ...requestFields,
  toolName: Schema.String,
  /** The SDK has no `title`; the card is built from `displayName` + `input`. */
  displayName: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  /** The model's own description of the call. */
  description: Schema.optionalKey(Schema.String),
  decisionReason: Schema.optionalKey(Schema.String),
  blockedPath: Schema.optionalKey(Schema.String),
  suggestions: Schema.Array(PermissionUpdate),
  /** Scopes the card may offer; absent means all. Outward app tools send `["once"]`. */
  scopes: Schema.optionalKey(Schema.Array(ApprovalScope)),
  /**
   * The public host an agent asks to browse in the Preview pane: the card offers "Always for this
   * host", whose `always` answer adds it to Settings → Agent may browse.
   */
  browseHost: Schema.optionalKey(Schema.String),
});
export type ApprovalRequest = typeof ApprovalRequest.Type;

/** What an approval is about: the command for shells, the path for file tools, else the input. */
export const approvalSubject = (request: Pick<ApprovalRequest, "input">): string => {
  const { input } = request;
  if (typeof input["command"] === "string") return input["command"];
  if (typeof input["file_path"] === "string") return input["file_path"];
  if (typeof input["url"] === "string") return input["url"];
  return JSON.stringify(input);
};

export const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.String,
  preview: Schema.optionalKey(Schema.String),
});
export type QuestionOption = typeof QuestionOption.Type;

export const Question = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(QuestionOption),
  multiSelect: Schema.Boolean,
});
export type Question = typeof Question.Type;

export const QuestionRequest = Schema.Struct({
  kind: Schema.Literal("question"),
  ...requestFields,
  questions: Schema.Array(Question),
});
export type QuestionRequest = typeof QuestionRequest.Type;

export const PlanRequest = Schema.Struct({
  kind: Schema.Literal("plan"),
  ...requestFields,
  plan: Schema.String,
  planFilePath: Schema.optionalKey(Schema.String),
});
export type PlanRequest = typeof PlanRequest.Type;

export const PendingRequest = Schema.Union([ApprovalRequest, QuestionRequest, PlanRequest]);
export type PendingRequest = typeof PendingRequest.Type;

export const ApprovalAnswer = Schema.Struct({
  kind: Schema.Literal("approval"),
  decision: Schema.Literals(["allow", "deny"]),
  scope: ApprovalScope,
  /** Deny reason or guidance passed back to the agent. */
  message: Schema.optionalKey(Schema.String),
});
export type ApprovalAnswer = typeof ApprovalAnswer.Type;

export const QuestionAnswer = Schema.Struct({
  kind: Schema.Literal("question"),
  /** Keyed by `Question.question`; values are selected option labels or free text. */
  answers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type QuestionAnswer = typeof QuestionAnswer.Type;

export const PlanAnswer = Schema.Struct({
  kind: Schema.Literal("plan"),
  decision: Schema.Literals(["approve", "reject"]),
  /** Mode to switch to on approval (Claude: `acceptEdits` by default). */
  mode: Schema.optionalKey(PermissionMode),
  message: Schema.optionalKey(Schema.String),
});
export type PlanAnswer = typeof PlanAnswer.Type;

export const RequestAnswer = Schema.Union([ApprovalAnswer, QuestionAnswer, PlanAnswer]);
export type RequestAnswer = typeof RequestAnswer.Type;

// ---------------------------------------------------------------------------------------------
// Plan and usage

export const PlanItemStatus = Schema.Literals(["pending", "inProgress", "completed", "cancelled"]);
export type PlanItemStatus = typeof PlanItemStatus.Type;

export const PlanItem = Schema.Struct({
  content: Schema.String,
  status: PlanItemStatus,
  /** Present-tense label while in progress ("Running tests"). */
  activeForm: Schema.optionalKey(Schema.String),
});
export type PlanItem = typeof PlanItem.Type;

export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheReadTokens: Schema.optionalKey(Schema.Int),
  cacheWriteTokens: Schema.optionalKey(Schema.Int),
  reasoningTokens: Schema.optionalKey(Schema.Int),
});
export type TokenUsage = typeof TokenUsage.Type;

/**
 * A turn's main-conversation cache writes by the lifetime the agent asked for. Claude Code chooses
 * a five-minute or one-hour TTL per request; this is the only evidence of which one a thread has.
 * Counts only.
 */
export const CacheWriteSplit = Schema.Struct({
  fiveMinute: Schema.Int,
  oneHour: Schema.Int,
});
export type CacheWriteSplit = typeof CacheWriteSplit.Type;

/** Tokens plus the context meter and cost ticker inputs. */
export const UsageSummary = Schema.Struct({
  /** Cumulative for the turn: the in/out display. */
  tokens: TokenUsage,
  /** Known lower bound when cumulative telemetry lacked a trustworthy baseline or reset. */
  partial: Schema.optionalKey(Schema.Boolean),
  /** Provenance for normalized Codex request deltas; absent when Codex gave no request basis. */
  telemetryVersion: Schema.optionalKey(
    Schema.Literals(["codex-request-delta-v1", "codex-last-request-v1"]),
  ),
  contextWindow: Schema.optionalKey(Schema.Int),
  /**
   * The latest request's whole prompt (input plus cache read and write), what the context meter
   * compares to `contextWindow`. Absent for agents that don't report per request.
   */
  contextTokens: Schema.optionalKey(Schema.Int),
  /** The whole thread so far, added up across its agent sessions. */
  costUsd: Schema.optionalKey(Schema.Number),
  /** `costUsd` includes a guess at the running turn, which the agent prices only once it ends. */
  costEstimated: Schema.optionalKey(Schema.Boolean),
  /** The turn's cache writes by TTL, when the agent reports them (Claude). */
  cacheWrites: Schema.optionalKey(CacheWriteSplit),
  /**
   * Epoch ms the input of the turn's last main request reached the agent: the turn's start, or a
   * later tool result or steer. Never after that request started, so a cache entry it wrote or read
   * lives at least until this plus its TTL. Absent while the turn runs.
   */
  lastRequestAt: Schema.optionalKey(Schema.Number),
});
export type UsageSummary = typeof UsageSummary.Type;

/**
 * Totals for one subagent run, keyed by the tool call that spawned it, as reported by the agent
 * while it runs and when a backgrounded one reports back. Each snapshot is the whole run so far, so
 * a later one replaces the one before it rather than adding to it. A foreground subagent's final
 * totals also arrive with its tool result (`TaskOutput`), which is the richer source; this is what
 * a running or backgrounded one has instead.
 */
export const SubagentUsage = Schema.Struct({
  /** The `Task`/`Agent` tool call this run belongs to. */
  toolCallId: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "stopped"]),
  /** Whole-run tokens; the agent reports no input/output split for a subagent. */
  totalTokens: Schema.optionalKey(Schema.Int),
  toolUses: Schema.optionalKey(Schema.Int),
  durationMs: Schema.optionalKey(Schema.Int),
  /**
   * Epoch ms the adapter saw the run start, repeated on every snapshot, so a running one can show a
   * live elapsed time. Absent where the agent reports no start.
   */
  startedAt: Schema.optionalKey(Schema.Int),
  /** The agent type spawned, e.g. `Explore`, when the agent names one. */
  subagentType: Schema.optionalKey(Schema.String),
  lastToolName: Schema.optionalKey(Schema.String),
  /**
   * A one-line status for the run's row while it works. Never its final report: that is the
   * transcript's job, and it has no length bound.
   */
  summary: Schema.optionalKey(Schema.String),
});
export type SubagentUsage = typeof SubagentUsage.Type;

/** What sort of work a background task is, from the agent's own task type. */
export const BackgroundTaskKind = Schema.Literals([
  "subagent",
  "shell",
  "workflow",
  "mcp",
  "other",
]);
export type BackgroundTaskKind = typeof BackgroundTaskKind.Type;

/**
 * Work the agent has running in the background, which outlives the turn that started it: a
 * backgrounded subagent, a `run_in_background` shell (or one the CLI moved there when it outran its
 * timeout). Housekeeping tasks and watchers are left out.
 */
export const BackgroundTask = Schema.Struct({
  /** The agent's id for it, which `thread.stopTask` takes. */
  taskId: Schema.NonEmptyString,
  kind: BackgroundTaskKind,
  /** What the caller said it's for: a subagent's description, a Bash call's `description`. */
  description: Schema.String,
  /** A shell's command line, from the tool call that started it. */
  command: Schema.optionalKey(Schema.String),
  /** The agent type of a subagent, e.g. `Explore`. */
  subagentType: Schema.optionalKey(Schema.String),
  /** The tool call that started it, whose card the transcript shows. */
  toolCallId: Schema.optionalKey(Schema.String),
  /** Epoch ms the adapter first saw it running; the agent reports no start time. */
  startedAt: Schema.Int,
});
export type BackgroundTask = typeof BackgroundTask.Type;

/** A running background shell's output tail, at most its last 8 KiB, as the adapter last read it. */
export const BackgroundOutput = Schema.Struct({
  /** The `BackgroundTask` it is the output of. */
  taskId: Schema.NonEmptyString,
  /** The tool call that started it. */
  toolCallId: Schema.optionalKey(Schema.String),
  output: Schema.String,
});
export type BackgroundOutput = typeof BackgroundOutput.Type;
