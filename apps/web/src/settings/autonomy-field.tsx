import type { Autonomy } from "@gram/contracts";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Expand } from "@/motion";

import { Field, LONG_COPY, OptionGroup } from "./fields";
import {
  AUTONOMY_LEVELS,
  autonomyLevel,
  autonomyNeedsConfirm,
  gateNote,
} from "./workspace-settings-model";

/**
 * How far this workspace's agents go unasked, with the selected level's
 * consequence in one line under it and the rest behind the ? by its label. Stepping up to Full is
 * confirmed in place first, since nothing asks after it.
 */
export function AutonomyField({
  value,
  disabled,
  error,
  onChange,
}: {
  /** The level the workspace is at, which a refused change leaves as it was. */
  value: Autonomy;
  disabled: boolean;
  /** Why the last change was refused, in the server's words. */
  error: string | undefined;
  onChange: (autonomy: Autonomy) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const level = autonomyLevel(value);
  const full = autonomyLevel("full");
  const note = gateNote(value);
  return (
    <Field
      label="Autonomy"
      learnMore={
        <>
          <p>{level.detail}</p>
          {note !== undefined && <p>{note.detail}</p>}
        </>
      }
      keywords={["supervised", "publish", "full", "push", "merge", "pull request", "gate"]}
    >
      <div data-testid="autonomy" data-value={value} className="flex flex-col gap-2">
        <OptionGroup
          label="Autonomy"
          options={AUTONOMY_LEVELS}
          value={value}
          disabled={disabled}
          onChange={(next) => {
            if (autonomyNeedsConfirm(value, next)) {
              setConfirming(true);
              return;
            }
            setConfirming(false);
            onChange(next);
          }}
        />
        <Expand open={confirming}>
          {confirming && (
            <div
              role="alertdialog"
              aria-label="Turn on Full autonomy?"
              data-testid="autonomy-confirm"
              className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/10 p-2.5 text-xs"
            >
              <p {...{ [LONG_COPY]: "consent" }} className="flex items-start gap-1.5">
                <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
                <span>
                  <span className="font-medium">Turn on Full autonomy?</span> {full.description}{" "}
                  {full.detail}
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirming(false);
                    onChange("full");
                  }}
                >
                  Turn on Full
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep {level.label}
                </Button>
              </div>
            </div>
          )}
        </Expand>
        {error !== undefined && (
          <p
            role="alert"
            data-testid="autonomy-error"
            className="flex items-start gap-1.5 text-xs whitespace-pre-wrap text-destructive"
          >
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
        {/* Keyed by the level, so the words for a new one fade in rather than swapping under the eye. */}
        <p
          key={value}
          data-testid="autonomy-description"
          className={cn(
            "gram-fade flex items-start gap-1.5 text-xs",
            level.warn ? "text-warning" : "text-muted-foreground",
          )}
        >
          {level.warn && <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />}
          <span>{level.description}</span>
        </p>
        {note !== undefined && (
          <p
            data-testid="orchestration-gate-warning"
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0 text-status-needs" />
            <span>{note.line}</span>
          </p>
        )}
      </div>
    </Field>
  );
}
