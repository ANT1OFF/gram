import {
  FEATURE_PLAN_MAX_STAGES,
  FEATURE_STAGE_MAX,
  FEATURE_STAGE_NOTE_MAX,
  type FeatureStage,
  type OrchestratorLedger,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";

import type { SetStageInput } from "@/api/types";

import { agoText } from "@/lib/time";

// Pure derivations for a feature's or a group's stage: somebody's word
// about where a change stands, so everything here keeps who said it and how long ago beside the
// stage itself.

/** A stage nobody has touched for this long is shown as possibly stale. */
export const STAGE_STALE_MS = 24 * 60 * 60_000;

export type StepStatus = "done" | "current" | "upcoming";

export interface StageStep {
  readonly name: string;
  readonly status: StepStatus;
}

export interface StepperModel {
  /** The plan's steps in order; `undefined` when the stage is a free label. */
  readonly steps: readonly StageStep[] | undefined;
  /** The current stage's name. */
  readonly current: string;
  /** "2 of 5", for a row with no room for the steps; `undefined` for a free label. */
  readonly position: string | undefined;
  /** "set by the orchestrator · 2h ago". */
  readonly attribution: string;
  /** Older than `STAGE_STALE_MS`: the word may no longer be true. */
  readonly stale: boolean;
  readonly note: string | undefined;
}

/**
 * A stage as the stepper shows it. A `stage` that isn't one of `plan` can't be placed among the
 * steps, so it reads as a free label rather than as a plan with nothing current.
 */
export const stepperModel = (stage: FeatureStage, now: number): StepperModel => {
  const index = stage.plan?.indexOf(stage.stage) ?? -1;
  const planned = stage.plan !== undefined && index >= 0;
  return {
    steps: planned
      ? stage.plan.map((name, i) => ({
          name,
          status: i < index ? "done" : i === index ? "current" : "upcoming",
        }))
      : undefined,
    current: stage.stage,
    position: planned ? `${index + 1} of ${stage.plan.length}` : undefined,
    attribution: `set by ${stage.setBy === "user" ? "you" : "the orchestrator"} · ${agoText(stage.setAt, now)}`,
    stale: now - stage.setAt > STAGE_STALE_MS,
    note: stage.note === undefined || stage.note.trim() === "" ? undefined : stage.note,
  };
};

/** The stage in one sentence, for a chip's tooltip. */
export const stageTitle = (model: StepperModel): string =>
  [
    `Stage: ${model.current}${model.position === undefined ? "" : ` (${model.position})`}`,
    model.attribution + (model.stale ? ", which may be out of date" : ""),
    ...(model.note === undefined ? [] : [model.note]),
  ].join("\n");

/** What a stage is set on: a feature, or a group of them. */
export type StageTarget = { readonly feature: string } | { readonly group: string };

/** The plan editor's draft: the steps as typed, which of them is current, and the note. */
export interface PlanDraft {
  /** The plan's steps in order; none means the stage is a free label. */
  readonly steps: readonly string[];
  /** Index into `steps` of the current one; ignored without steps. */
  readonly current: number;
  /** The stage when there are no steps. */
  readonly label: string;
  readonly note: string;
}

export const draftOfStage = (stage: FeatureStage | undefined): PlanDraft => {
  const index = stage?.plan?.indexOf(stage.stage) ?? -1;
  const planned = stage?.plan !== undefined && index >= 0;
  return {
    steps: planned ? stage.plan : [],
    current: planned ? index : 0,
    label: stage?.stage ?? "",
    note: stage?.note ?? "",
  };
};

/** `steps[from]` moved to `to`, the current step going with its name rather than staying at its index. */
export const moveStep = (draft: PlanDraft, from: number, to: number): PlanDraft => {
  if (from === to || to < 0 || to >= draft.steps.length || from < 0 || from >= draft.steps.length) {
    return draft;
  }
  const steps = [...draft.steps];
  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, moved!);
  const order = draft.steps.map((_, index) => index);
  const [index] = order.splice(from, 1);
  order.splice(to, 0, index!);
  return { ...draft, steps, current: order.indexOf(draft.current) };
};

/** Without `steps[index]`; the current step stays the same one, or becomes the one that took its place. */
export const removeStep = (draft: PlanDraft, index: number): PlanDraft => {
  const steps = draft.steps.filter((_, i) => i !== index);
  const current = index < draft.current ? draft.current - 1 : draft.current;
  return {
    ...draft,
    steps,
    current: Math.max(0, Math.min(current, steps.length - 1)),
    // Removing the last step leaves a free label: start it from what the stage was called.
    label: steps.length === 0 ? (draft.steps[draft.current] ?? draft.label) : draft.label,
  };
};

/** One more empty step, up to the plan's limit. */
export const addStep = (draft: PlanDraft): PlanDraft =>
  draft.steps.length >= FEATURE_PLAN_MAX_STAGES
    ? draft
    : {
        ...draft,
        // A free label becomes the plan's first step, so nothing typed is lost.
        steps:
          draft.steps.length === 0 && draft.label.trim() !== ""
            ? [draft.label.trim(), ""]
            : [...draft.steps, ""],
      };

/**
 * What to send for a draft, or the sentence saying why it can't be: the same rules the server
 * holds a stage to, so the refusal is said before the round trip. An empty plan is sent as `[]`,
 * which is how the server is told to drop the plan it has.
 */
export const validatePlanDraft = (
  draft: PlanDraft,
):
  | { readonly input: Pick<SetStageInput, "stage" | "plan" | "note"> }
  | { readonly error: string } => {
  const steps = draft.steps.map((step) => step.trim());
  const names = steps.length === 0 ? [draft.label.trim()] : steps;
  if (names.some((name) => name === "")) {
    return { error: steps.length === 0 ? "Name the stage." : "Every step needs a name." };
  }
  const long = names.find((name) => name.length > FEATURE_STAGE_MAX);
  if (long !== undefined) {
    return {
      error: `“${long.slice(0, 20)}…” is too long: a stage's name is at most ${FEATURE_STAGE_MAX} characters.`,
    };
  }
  if (new Set(steps).size !== steps.length) return { error: "Two steps have the same name." };
  if (steps.length > FEATURE_PLAN_MAX_STAGES) {
    return { error: `A plan has at most ${FEATURE_PLAN_MAX_STAGES} steps.` };
  }
  const note = draft.note.trim();
  if (note.length > FEATURE_STAGE_NOTE_MAX) {
    return { error: `The note is at most ${FEATURE_STAGE_NOTE_MAX} characters.` };
  }
  return {
    input: {
      stage: steps.length === 0 ? names[0]! : (steps[draft.current] ?? steps[0]!),
      plan: steps,
      ...(note === "" ? {} : { note }),
    },
  };
};

/** The stage the server will store for `input`, as far as the client can tell: shown while it answers. */
export const optimisticStage = (
  current: FeatureStage | undefined,
  input: Pick<SetStageInput, "stage" | "plan" | "note">,
  now: number,
): FeatureStage => {
  const plan =
    input.plan === undefined ? current?.plan : input.plan.length === 0 ? undefined : input.plan;
  return {
    ...(plan === undefined ? {} : { plan }),
    stage: input.stage,
    ...(input.note === undefined ? {} : { note: input.note }),
    setBy: "user",
    setAt: now,
  };
};

/** `state` with the stage set on the target; a group the workspace doesn't list is left alone. */
export const withStage = (
  state: WorkspaceState,
  target: StageTarget,
  stage: FeatureStage,
): WorkspaceState => {
  if ("feature" in target)
    return { ...state, stages: { ...state.stages, [target.feature]: stage } };
  const group = state.groups?.[target.group];
  return group === undefined
    ? state
    : { ...state, groups: { ...state.groups, [target.group]: { ...group, stage } } };
};

/** The same on a ledger, which is what the board draws from. */
export const ledgerWithStage = (
  ledger: OrchestratorLedger,
  target: StageTarget,
  stage: FeatureStage,
): OrchestratorLedger =>
  "feature" in target
    ? {
        ...ledger,
        features: ledger.features.map((feature) =>
          feature.feature === target.feature ? { ...feature, stage } : feature,
        ),
      }
    : {
        ...ledger,
        ...(ledger.groups === undefined
          ? {}
          : {
              groups: ledger.groups.map((group) =>
                group.group === target.group ? { ...group, stage } : group,
              ),
            }),
      };

const ledgerStage = (
  ledger: OrchestratorLedger,
  target: StageTarget,
): { readonly stage?: FeatureStage | undefined } | undefined =>
  "feature" in target
    ? ledger.features.find((feature) => feature.feature === target.feature)
    : ledger.groups?.find((group) => group.group === target.group);

/**
 * A stage set from this window that the ledger stream has yet to show. The server reads the
 * workspace and then surveys its workers over many awaits, so a ledger that read it before the write
 * can be streamed after the write, and after the answer to it too.
 */
interface HeldStage {
  readonly target: StageTarget;
  /** The optimistic stage until the server answers, and what it stored from then on. */
  readonly stage: FeatureStage;
  /** False while the server is asked, when every ledger there is was built before the write. */
  readonly confirmed: boolean;
}

/**
 * An incoming ledger with the held stages it predates laid over it, and the ones to go on holding.
 * A ledger has caught up with a confirmed stage once it carries one set no earlier, whoever set
 * that; a target that has gone from the ledger has nothing left to hold.
 */
const settleLedger = (
  ledger: OrchestratorLedger,
  held: readonly HeldStage[],
): { readonly ledger: OrchestratorLedger; readonly held: readonly HeldStage[] } => {
  const pending = held.filter((hold) => {
    if (!hold.confirmed) return true;
    const shown = ledgerStage(ledger, hold.target);
    return shown !== undefined && (shown.stage?.setAt ?? -Infinity) < hold.stage.setAt;
  });
  return {
    ledger: pending.reduce((next, hold) => ledgerWithStage(next, hold.target, hold.stage), ledger),
    held: pending,
  };
};

/** The stages this window set and the ledger stream has yet to show, by workspace. */
export interface StageHolds {
  /**
   * Holds `stage` over every incoming ledger of the workspace. `confirm` swaps in what the server
   * stored, which a later ledger then ends the hold by showing; `release` ends it for a refusal.
   * Both do nothing once a newer hold on the same target has replaced this one.
   */
  hold(
    workspaceId: WorkspaceId,
    target: StageTarget,
    stage: FeatureStage,
  ): { confirm(stored: FeatureStage): void; release(): void };
  /** A ledger from the server, streamed or fetched, as it should be shown. */
  settle(ledger: OrchestratorLedger): OrchestratorLedger;
}

const sameTarget = (a: StageTarget, b: StageTarget): boolean =>
  "feature" in a ? "feature" in b && a.feature === b.feature : "group" in b && a.group === b.group;

export function createStageHolds(): StageHolds {
  const byWorkspace = new Map<WorkspaceId, readonly HeldStage[]>();
  const put = (workspaceId: WorkspaceId, held: readonly HeldStage[]) => {
    if (held.length === 0) byWorkspace.delete(workspaceId);
    else byWorkspace.set(workspaceId, held);
  };
  return {
    hold(workspaceId, target, stage) {
      const mine: HeldStage = { target, stage, confirmed: false };
      const others = (byWorkspace.get(workspaceId) ?? []).filter(
        (hold) => !sameTarget(hold.target, target),
      );
      put(workspaceId, [...others, mine]);
      const swap = (next: HeldStage | undefined) => {
        const held = byWorkspace.get(workspaceId) ?? [];
        if (!held.includes(mine)) return;
        put(
          workspaceId,
          held.flatMap((hold) => (hold !== mine ? [hold] : next === undefined ? [] : [next])),
        );
      };
      return {
        confirm: (stored) => swap({ target, stage: stored, confirmed: true }),
        release: () => swap(undefined),
      };
    },
    settle(ledger) {
      const settled = settleLedger(ledger, byWorkspace.get(ledger.workspaceId) ?? []);
      put(ledger.workspaceId, settled.held);
      return settled.ledger;
    },
  };
}

/** The stage a target carries now, from the workspace. */
export const stageOf = (state: WorkspaceState, target: StageTarget): FeatureStage | undefined =>
  "feature" in target ? state.stages?.[target.feature] : state.groups?.[target.group]?.stage;

/** A group name as the server will slug it, to show before saving; `undefined` for one it would refuse. */
export const groupSlug = (raw: string): string | undefined => {
  const slug = raw
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" || slug.length > 48 ? undefined : slug;
};
