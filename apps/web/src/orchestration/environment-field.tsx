import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { errorMessage } from "@/api/errors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ShellEnvironmentList } from "@/embed/contract";
import { useEmbedShell } from "@/embed/store";
import { Spinner } from "@/motion";

import { environmentShown } from "./environment-field-model";

/** The query key of the embedding app's environments, read once per page and shared. */
export const ENVIRONMENTS_QUERY_KEY = ["embed", "environments"] as const;

/** The embedding app's environments, where it offers a choice: `undefined` where it offers none. */
export const useEnvironments = () => {
  const source = useEmbedShell((s) => s.environments);
  const query = useQuery({
    queryKey: ENVIRONMENTS_QUERY_KEY,
    queryFn: ({ signal }): Promise<ShellEnvironmentList> => source!.list({ signal }),
    enabled: source !== undefined,
    staleTime: 30_000,
  });
  return source === undefined ? undefined : query;
};

/**
 * Where a workspace's machine starts, where the embedding app offers a choice: its environments,
 * the default marked, each with what it is in a few words. `value` is the workspace's own pick;
 * absent, it starts in the default. A pick that is no longer offered says it starts in the default.
 * Nothing at all where the app offers no choice.
 */
export function EnvironmentField({
  value,
  onChange,
  disabled = false,
  testId = "environment",
  description,
}: {
  value: string | undefined;
  /** The pick; `undefined` for the default. */
  onChange: (environment: string | undefined) => void;
  disabled?: boolean;
  testId?: string;
  description?: string;
}) {
  const listed = useEnvironments();
  const labelId = useId();
  if (listed === undefined) return null;
  const head = (
    <span id={labelId} className="text-meta font-medium text-muted-foreground">
      Environment
    </span>
  );
  if (listed.isPending)
    return (
      <div className="flex flex-col gap-1.5" data-testid={testId}>
        {head}
        <span role="status" className="flex items-center gap-2 text-meta text-muted-foreground">
          <Spinner aria-hidden className="size-icon-row" />
          Loading…
        </span>
      </div>
    );
  if (listed.isError)
    return (
      <div className="flex flex-col gap-1.5" data-testid={testId}>
        {head}
        <span role="alert" className="text-meta text-destructive">
          {errorMessage(listed.error) || "Couldn't read the environments."}
        </span>
      </div>
    );
  const list = listed.data;
  const shown = environmentShown(list, value);
  const items = list.environments.map((each) => ({ value: each.id, label: each.label }));
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {head}
      {description !== undefined && (
        <span className="text-meta text-muted-foreground">{description}</span>
      )}
      <Select
        disabled={disabled || list.environments.length < 2}
        value={shown.picked.id}
        items={items}
        onValueChange={(next) => {
          if (next === null) return;
          onChange(next === list.default ? undefined : next);
        }}
      >
        <SelectTrigger aria-labelledby={labelId} className="w-full" data-testid={`${testId}-pick`}>
          <SelectValue />
          {shown.picked.detail !== undefined && (
            <span className="min-w-0 truncate text-meta text-muted-foreground">
              {shown.picked.detail}
            </span>
          )}
        </SelectTrigger>
        <SelectContent>
          {list.environments.map((each) => (
            <SelectItem key={each.id} value={each.id}>
              <span className="flex min-w-0 flex-col">
                <span className="flex items-baseline gap-2">
                  <span className="font-medium">{each.label}</span>
                  {each.id === list.default && (
                    <span className="text-meta text-muted-foreground">Default</span>
                  )}
                </span>
                {each.detail !== undefined && (
                  <span className="text-meta text-muted-foreground">{each.detail}</span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {shown.gone ? (
        <span role="status" className="text-meta text-muted-foreground">
          {`Its environment is no longer offered. It starts in ${shown.picked.label}.`}
        </span>
      ) : list.environments.length < 2 && list.manage !== undefined ? (
        <span className="text-meta text-muted-foreground">
          The only environment. <ManageLink manage={list.manage} />
        </span>
      ) : (
        list.manage !== undefined && (
          <span className="text-meta">
            <ManageLink manage={list.manage} />
          </span>
        )
      )}
    </div>
  );
}

function ManageLink({ manage }: { manage: NonNullable<ShellEnvironmentList["manage"]> }) {
  return (
    <Link
      to={manage.to}
      className="rounded-sm text-foreground underline underline-offset-2 outline-none hover:text-foreground/80 focus-visible:focus-ring"
    >
      {manage.label}
    </Link>
  );
}
