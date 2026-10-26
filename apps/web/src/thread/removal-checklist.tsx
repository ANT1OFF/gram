import type { UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { Shimmer } from "@/motion";

const field = (error: unknown, key: string): unknown =>
  typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;

/** The uncommitted change count from a `WorktreeDirty` rejection (0 when unknown); else `undefined`. */
export function worktreeDirtyCount(error: unknown): number | undefined {
  if (field(error, "_tag") !== "WorktreeDirty") return undefined;
  const changed = field(error, "changedFiles");
  return typeof changed === "number" ? changed : 0;
}

/** The pending permission rules the user unticked; every other rule is carried to the main checkout. */
export function useSkippedRules() {
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const toggle = (rule: string) =>
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      return next;
    });
  const picked = (rules: readonly string[] | undefined) =>
    (rules ?? []).filter((rule) => !skipped.has(rule));
  return { skipped, toggle, picked };
}

/** The worktree's pending permission rules as ticked checkboxes, with loading and error states. */
export function PermissionChecklist({
  rules,
  skipped,
  onToggle,
}: {
  rules: UseQueryResult<readonly string[]>;
  skipped: ReadonlySet<string>;
  onToggle: (rule: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {rules.status === "pending" ? (
        <p className="text-xs text-muted-foreground">
          <Shimmer>Checking permission rules…</Shimmer>
        </p>
      ) : rules.status === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn't read the worktree's permission rules: {errorMessage(rules.error)}
        </p>
      ) : (
        rules.data.length > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs text-muted-foreground">
              These permission rules were approved in this worktree. Add them to the main checkout
              so future threads inherit them:
            </legend>
            {rules.data.map((rule) => (
              <label key={rule} className="flex items-center gap-2 font-mono text-xs">
                <input
                  type="checkbox"
                  checked={!skipped.has(rule)}
                  onChange={() => onToggle(rule)}
                />
                {rule}
              </label>
            ))}
          </fieldset>
        )
      )}
    </div>
  );
}

/** Asks again after a `WorktreeDirty` refusal, before forcing the worktree away. */
export function DirtyAlert({ changedFiles }: { changedFiles: number }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive-tint px-2 py-1.5 text-xs"
    >
      This worktree has{" "}
      {changedFiles > 0
        ? `${changedFiles} uncommitted change${changedFiles === 1 ? "" : "s"}`
        : "uncommitted or unmerged changes"}
      . Delete it anyway? This permanently discards that work.
    </p>
  );
}
