import {
  FEATURE_PLAN_MAX_STAGES,
  FEATURE_STAGE_MAX,
  FEATURE_STAGE_NOTE_MAX,
  type FeatureStage,
} from "@gram/contracts";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useId, useState } from "react";

import type { SetStageInput } from "@/api/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PresenceItem, PresenceList } from "@/motion";

import {
  addStep,
  draftOfStage,
  moveStep,
  removeStep,
  validatePlanDraft,
  type PlanDraft,
} from "./stage-model";
import { useFocusOnOpen } from "./use-focus-on-open";

const INPUT =
  "h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";
const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

/**
 * The plan of a feature or a group, edited in place: up to eight short
 * step names in an order the arrows change, which of them is current, and a note. With no steps the
 * stage is one free label. Free text on purpose: there is no template to pick from, as a team's
 * usual flow lives in the orchestrator's memory.
 */
export function StageEditor({
  subject,
  stage,
  onSave,
  onCancel,
}: {
  /** What the stage is of: "mail-trigger". */
  subject: string;
  stage: FeatureStage | undefined;
  /** Resolves to whether the server took it; the editor stays open when it didn't. */
  onSave: (input: Pick<SetStageInput, "stage" | "plan" | "note">) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<PlanDraft>(() => draftOfStage(stage));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // Steps are edited by position, and a step's name changes as it is typed, so each keeps a key of
  // its own that travels with it when it moves.
  const [keys, setKeys] = useState<readonly number[]>(() => draft.steps.map((_, i) => i));
  const [nextKey, setNextKey] = useState(draft.steps.length);
  const name = useId();
  const noteId = useId();
  const labelId = useId();
  // The free label, or the step it stands at: whichever there is to type in first.
  const focus = useFocusOnOpen<HTMLInputElement>();
  const [focusKey] = useState(() => keys[draft.current]);

  const apply = (next: PlanDraft, nextKeys: readonly number[]) => {
    setError(undefined);
    setDraft(next);
    setKeys(nextKeys);
  };
  const move = (from: number, to: number) => {
    const order = [...keys];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved!);
    apply(moveStep(draft, from, to), order);
  };
  const add = () => {
    const next = addStep(draft);
    const added = next.steps.length - draft.steps.length;
    apply(next, [...keys, ...Array.from({ length: added }, (_, i) => nextKey + i)]);
    setNextKey(nextKey + added);
  };

  const submit = () => {
    const result = validatePlanDraft(draft);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSaving(true);
    void onSave(result.input).then((ok) => {
      if (ok) onCancel();
      else setSaving(false);
    });
  };

  return (
    <form
      aria-label={`Plan of ${subject}`}
      data-testid="stage-editor"
      className="flex max-w-xl flex-col gap-2 rounded-(--radius-md) border border-border bg-card p-2.5 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="font-medium">Plan of {subject}</p>
      {draft.steps.length === 0 ? (
        <label htmlFor={labelId} className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            The stage, as a free label. Add steps to show it as a plan instead.
          </span>
          <input
            ref={focus}
            id={labelId}
            data-testid="stage-editor-label"
            className={INPUT}
            maxLength={FEATURE_STAGE_MAX}
            value={draft.label}
            placeholder="waiting on the API team"
            onChange={(event) => apply({ ...draft, label: event.target.value }, keys)}
          />
        </label>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-muted-foreground">
            Steps in order. The marked one is where it stands now.
          </legend>
          <ol className="flex flex-col gap-1">
            <PresenceList>
              {draft.steps.map((step, index) => (
                <PresenceItem
                  as="li"
                  key={keys[index]}
                  glide
                  data-testid="stage-editor-step"
                  className="flex items-center gap-1"
                >
                  <input
                    type="radio"
                    name={name}
                    aria-label={`${step.trim() === "" ? `Step ${index + 1}` : step} is the current stage`}
                    className="size-3.5 shrink-0 accent-primary"
                    checked={draft.current === index}
                    onChange={() => apply({ ...draft, current: index }, keys)}
                  />
                  <input
                    ref={keys[index] === focusKey ? focus : undefined}
                    aria-label={`Step ${index + 1}`}
                    className={cn(INPUT, draft.current === index && "font-medium")}
                    maxLength={FEATURE_STAGE_MAX}
                    value={step}
                    placeholder="a short name"
                    onChange={(event) =>
                      apply(
                        {
                          ...draft,
                          steps: draft.steps.map((s, i) => (i === index ? event.target.value : s)),
                        },
                        keys,
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} up`}
                    className={ICON_BUTTON}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <ArrowUp aria-hidden className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} down`}
                    className={ICON_BUTTON}
                    disabled={index === draft.steps.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <ArrowDown aria-hidden className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove step ${index + 1}`}
                    className={ICON_BUTTON}
                    onClick={() =>
                      apply(
                        removeStep(draft, index),
                        keys.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </PresenceItem>
              ))}
            </PresenceList>
          </ol>
        </fieldset>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="stage-editor-add"
          disabled={draft.steps.length >= FEATURE_PLAN_MAX_STAGES}
          onClick={add}
        >
          <Plus data-icon="inline-start" />
          Add step
        </Button>
        <span className="text-muted-foreground tabular-nums">
          {draft.steps.length}/{FEATURE_PLAN_MAX_STAGES}
        </span>
      </div>
      <label htmlFor={noteId} className="flex flex-col gap-1">
        <span className="text-muted-foreground">Note (optional)</span>
        <textarea
          id={noteId}
          data-testid="stage-editor-note"
          rows={2}
          maxLength={FEATURE_STAGE_NOTE_MAX}
          className={cn(INPUT, "h-auto resize-y py-1")}
          value={draft.note}
          onChange={(event) => apply({ ...draft, note: event.target.value }, keys)}
        />
      </label>
      {error !== undefined && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="xs" disabled={saving} data-testid="stage-editor-save">
          Save plan
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-muted-foreground">
          The orchestrator reads the change in its next digest.
        </span>
      </div>
    </form>
  );
}
