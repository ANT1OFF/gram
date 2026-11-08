import type { OrchestratorCharter, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "@/api/context";
import { Field, inputCls, Toggle } from "./fields";

export function AutomaticDreamField({
  workspaceId,
  charter,
  disabled,
  onChange,
}: {
  workspaceId: WorkspaceId;
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter) => void;
}) {
  const api = useApi();
  const threshold = charter.automaticDreamThreshold;
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const status = useQuery({
    queryKey: ["automaticDreamStatus", workspaceId],
    queryFn: () => api.automaticDreamStatus(workspaceId),
    enabled: threshold !== undefined,
  });
  const commit = () => {
    if (disabled || draft === undefined) return;
    const value = Number(draft);
    if (!/^\d+$/.test(draft) || !Number.isInteger(value) || value < 1 || value > 1000) {
      setError("Choose a whole number from 1 to 1000.");
      return;
    }
    setDraft(undefined);
    setError(undefined);
    if (value !== threshold) onChange({ ...charter, automaticDreamThreshold: value });
  };
  return (
    <div data-testid="automatic-dream-setting" className="flex flex-col gap-2">
      <Toggle
        label="Update memory automatically"
        checked={threshold !== undefined}
        disabled={disabled}
        description="Start a memory update, which drafts memory from past threads, once enough finish."
        learnMore={
          <p>
            Each run waits for your review. Turning this on or changing the threshold starts a fresh
            count; earlier completions do not trigger a run. A manual or automatic start resets the
            count. Failed or cancelled runs need a fresh batch.
          </p>
        }
        keywords={["memory update", "dream", "automatic", "completed threads", "memory"]}
        onChange={(on) => {
          setDraft(undefined);
          setError(undefined);
          const { automaticDreamThreshold: _previous, ...rest } = charter;
          onChange(on ? { ...rest, automaticDreamThreshold: 10 } : rest);
        }}
      />
      {threshold !== undefined && (
        <>
          <Field
            label="Threads per memory update"
            description="How many threads finish here before a memory update starts."
            htmlFor={`dream-threshold-${workspaceId}`}
          >
            <input
              id={`dream-threshold-${workspaceId}`}
              aria-label="Threads per memory update"
              type="number"
              min={1}
              max={1000}
              step={1}
              className={inputCls}
              disabled={disabled}
              value={draft ?? String(threshold)}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(undefined);
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                }
              }}
            />
          </Field>
          {error && (
            <p role="alert" className="text-meta text-destructive">
              {error}
            </p>
          )}
          <p data-testid="automatic-dream-progress" className="text-meta text-muted-foreground">
            {status.data?.completed ?? 0} / {threshold} completed threads.{" "}
            {status.data?.detail ?? "Loading automatic memory update status…"}
          </p>
          {status.isError && (
            <p role="alert" className="text-meta text-destructive">
              Automatic memory update status could not be loaded.
            </p>
          )}
        </>
      )}
    </div>
  );
}
