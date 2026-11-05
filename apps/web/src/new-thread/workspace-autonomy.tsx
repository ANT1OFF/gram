import type { Autonomy, WorkspaceState } from "@gram/contracts";
import { autonomyOf } from "@gram/contracts";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, Shield, TriangleAlert } from "lucide-react";
import { createElement, useState } from "react";

import { ChoiceCheck } from "@/components/choice-check";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AUTONOMY_ICON } from "@/orchestration/autonomy-chip";
import { useWorkspaceChanges } from "@/settings/workspace-actions";
import {
  AUTONOMY_LEVELS,
  autonomyLevel,
  autonomyNeedsConfirm,
  presentAutonomy,
  withAutonomy,
} from "@/settings/workspace-settings-model";
import { known } from "@/thread/orchestration-model";

import { AUTONOMY_LINE } from "./autonomy-choice";

/** The level's glyph, placed as the button places a leading icon. */
const ICON_PROPS = { "aria-hidden": true, "data-icon": "inline-start" } as const;

/** "Workspace: full autonomy": the trigger's words, the level in lower case. */
export const workspaceAutonomyLabel = (autonomy: string): string =>
  `Workspace: ${presentAutonomy(autonomy).label.toLowerCase()} autonomy`;

/** What a level lets agents do unasked, in one line: the picker's own words. */
export const autonomySummary = (autonomy: string): string =>
  known(AUTONOMY_LINE, autonomy as Autonomy) ?? presentAutonomy(autonomy).description;

/**
 * The New form's word on the workspace's autonomy where work starts: "Workspace: full autonomy ▾",
 * then what that lets its agents do without asking. The trigger opens the three levels to change
 * it there, saved as Settings saves it (with Undo); stepping up to Full is confirmed first. Before
 * the workspace is known it reads the default and offers no change.
 */
export function WorkspaceAutonomy({
  state,
  autonomy,
}: {
  state: WorkspaceState | undefined;
  /** The level to show: the workspace's, else the default a new one starts at. */
  autonomy: Autonomy;
}) {
  const changes = useWorkspaceChanges(state);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const charter = changes.charter ?? state?.charter;
  const value = charter === undefined ? autonomy : autonomyOf(charter);
  const level = presentAutonomy(value);
  const icon = known(AUTONOMY_ICON, value as Autonomy) ?? Shield;
  const label = workspaceAutonomyLabel(value);

  const pick = (next: Autonomy) => {
    if (charter === undefined || next === value) return;
    if (autonomyNeedsConfirm(value as Autonomy, next)) {
      setConfirming(true);
      return;
    }
    save(next);
  };
  const save = (next: Autonomy) => {
    if (charter === undefined) return;
    setConfirming(false);
    setError(undefined);
    void changes.saveCharter(
      withAutonomy(charter, next),
      `Autonomy set to ${autonomyLevel(next).label}`,
      setError,
    );
  };

  return (
    <span
      data-testid="workspace-autonomy"
      data-autonomy={value}
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta"
    >
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirming(false);
        }}
      >
        <Popover.Trigger
          disabled={state === undefined}
          render={
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="workspace-autonomy-trigger"
              aria-label={`${label}. Change`}
              className={cn(
                "font-normal",
                level.warn
                  ? "border-warning/50 text-warning dark:border-warning/50"
                  : "text-muted-foreground",
              )}
            />
          }
        >
          {createElement(icon, ICON_PROPS)}
          {label}
          <ChevronDown aria-hidden data-icon="inline-end" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={6} className="isolate z-50">
            <Popover.Popup
              data-surface="overlay"
              aria-label="Workspace autonomy"
              data-testid="workspace-autonomy-menu"
              className="flex w-80 flex-col gap-2 rounded-md border border-border bg-popover p-2 text-meta text-popover-foreground shadow-overlay outline-none"
            >
              <p className="px-1 text-muted-foreground">
                What {state?.workspace.name ?? "this workspace"}'s orchestrator and workers may do
                without asking you. Each agent's own permission mode still applies.
              </p>
              <div role="radiogroup" aria-label="Autonomy" className="flex flex-col gap-0.5">
                {AUTONOMY_LEVELS.map((each) => {
                  const checked = each.value === value;
                  return (
                    <button
                      key={each.value}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={each.label}
                      aria-description={AUTONOMY_LINE[each.value]}
                      data-testid={`workspace-autonomy-${each.value}`}
                      disabled={changes.busy}
                      onClick={() => pick(each.value)}
                      className="flex flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none hover:row-cursor focus-visible:focus-ring-inset disabled:opacity-50 aria-checked:choice-selected"
                    >
                      <span className="flex w-full items-center gap-1.5 text-reading font-medium">
                        {each.label}
                        <ChoiceCheck checked={checked} className="ml-auto" />
                      </span>
                      <span className="text-muted-foreground">{AUTONOMY_LINE[each.value]}</span>
                    </button>
                  );
                })}
              </div>
              {confirming && (
                <div
                  role="alertdialog"
                  aria-label="Turn on Full autonomy?"
                  data-testid="workspace-autonomy-confirm"
                  className="flex flex-col gap-2 rounded-md border border-warning/50 p-2"
                >
                  <p className="flex items-start gap-1.5">
                    <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
                    <span>
                      <span className="font-medium">Turn on Full autonomy?</span>{" "}
                      {autonomyLevel("full").description}
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="xs" variant="destructive" onClick={() => save("full")}>
                      Turn on Full
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                      Keep {level.label}
                    </Button>
                  </div>
                </div>
              )}
              {error !== undefined && (
                <p role="alert" className="px-1 whitespace-pre-wrap text-destructive">
                  {error}
                </p>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <span data-testid="workspace-autonomy-summary" className="text-muted-foreground">
        {autonomySummary(value)}
      </span>
    </span>
  );
}
