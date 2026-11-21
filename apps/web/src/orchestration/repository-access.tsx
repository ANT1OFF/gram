import type { ProjectId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleAlert, User } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useServes } from "@/api/use-serves";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import type {
  ShellRepositories,
  ShellRepositoryAbility,
  ShellRepositoryAccess,
} from "@/embed/contract";
import { useEmbedShell } from "@/embed/store";
import { FOCUS_RING } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";

import { abilityTone, checksLine, repositoryAccessRows } from "./repository-access-model";

/**
 * What the agents can do here: for each picked repository on GitHub, whether they can push a
 * branch, open a pull request and merge one, and which checks a merge waits for, as the
 * embedding app enforces it (`shell.repositories.access`). Shown under the autonomy, which says
 * what they do unasked; this says what they can do at all. Nothing without the app's source.
 */
export function RepositoryAccess({ projectIds }: { projectIds: readonly ProjectId[] }) {
  const access = useEmbedShell((s) => s.repositories?.access);
  const served = useServes("projects.origins");
  if (access === undefined || projectIds.length === 0 || !served) return null;
  return <RepositoryAccessTable projectIds={projectIds} access={access} />;
}

function RepositoryAccessTable({
  projectIds,
  access,
}: {
  projectIds: readonly ProjectId[];
  access: NonNullable<ShellRepositories["access"]>;
}) {
  const api = useApi();
  const ids = projectIds.toSorted();
  const origins = useQuery({
    queryKey: ["projects", "origins", ids],
    queryFn: ({ signal }) => withinTime(signal, () => api.projectOrigins(ids)),
    staleTime: 60_000,
    retry: false,
  });
  const names = [
    ...new Set((origins.data?.origins ?? []).flatMap(({ github }) => (github ? [github] : []))),
  ].toSorted();
  const answer = useQuery({
    queryKey: ["embed", "repository-access", names],
    queryFn: ({ signal }) =>
      withinTime(signal, (bounded) => access({ repositories: names, signal: bounded })),
    enabled: names.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const offGitHub = (origins.data?.origins ?? []).filter(({ github }) => github === undefined);
  if (origins.isSuccess && names.length === 0) return null;
  const rows = answer.data === undefined ? [] : repositoryAccessRows(names, answer.data);
  const failed = origins.isError ? origins.error : answer.isError ? answer.error : undefined;
  const reading = failed === undefined && (origins.isPending || answer.isFetching);
  const retry = () => void (origins.isError ? origins.refetch() : answer.refetch());

  return (
    <div data-testid="new-workspace-access" className="flex flex-col gap-2">
      <span className="text-meta font-medium text-muted-foreground">
        What the agents can do here
      </span>
      {reading && (
        <span className="flex items-center gap-2 text-meta text-muted-foreground">
          <Spinner aria-hidden className="size-icon-row" />
          Reading what the agents can do…
        </span>
      )}
      {failed !== undefined && (
        <span
          role="status"
          className="flex flex-wrap items-center gap-2 text-meta text-warning-text"
        >
          {errorMessage(failed)}
          <Button type="button" size="xs" variant="outline" onClick={retry}>
            Retry
          </Button>
        </span>
      )}
      {rows.length > 0 && (
        <div className="@container rounded-lg border border-border">
          <table className="w-full table-fixed text-meta @max-md:block">
            <colgroup>
              <col className="w-[31%]" />
              <col className="w-[25%]" />
              <col className="w-[22%]" />
              <col className="w-[22%]" />
            </colgroup>
            <thead className="@max-md:sr-only">
              <tr className="text-left align-bottom text-muted-foreground">
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="px-2.5 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="@max-md:block">
              {rows.map((row) => (
                <AccessRow key={row.fullName} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {answer.data !== undefined && (
        <AccessFoot note={answer.data.note} link={answer.data.link} offGitHub={offGitHub.length} />
      )}
    </div>
  );
}

/** How long the card waits for the embedding app before it says so and offers Retry. */
export const ACCESS_TIMEOUT_MS = 20_000;

async function withinTime<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>) {
  const deadline = AbortSignal.timeout(ACCESS_TIMEOUT_MS);
  const bounded = AbortSignal.any([signal, deadline]);
  const late = new Promise<never>((_, reject) => {
    bounded.addEventListener(
      "abort",
      () =>
        reject(
          deadline.aborted
            ? new Error("This took too long to read, so what the agents can do isn't known yet.")
            : bounded.reason,
        ),
      { once: true },
    );
  });
  return Promise.race([run(bounded), late]);
}

const COLUMNS = ["Repository", "Push a branch", "Pull request", "Merge"] as const;

function AccessRow({ row }: { row: ShellRepositoryAccess }) {
  return (
    <tr
      data-testid="new-workspace-access-row"
      className="border-t border-border align-top first:border-t-0 @md:first:border-t @max-md:grid @max-md:grid-cols-3"
    >
      <th scope="row" className="px-2.5 py-2 text-left font-normal @max-md:col-span-3 @max-md:pb-0">
        <span className="block break-words text-foreground">{row.fullName}</span>
        <span data-testid="new-workspace-access-checks" className="block text-muted-foreground">
          {checksLine(row.checks)}
        </span>
      </th>
      <AbilityCell column={COLUMNS[1]} ability={row.push} fix={row.fix} />
      <AbilityCell column={COLUMNS[2]} ability={row.pullRequest} />
      <AbilityCell column={COLUMNS[3]} ability={row.merge} person />
    </tr>
  );
}

function AbilityCell({
  column,
  ability,
  person = false,
  fix,
}: {
  column: string;
  ability: ShellRepositoryAbility;
  person?: boolean;
  fix?: ShellRepositoryAccess["fix"];
}) {
  const tone = abilityTone(ability, person);
  const Mark = { yes: Check, person: User, no: CircleAlert, moot: undefined }[tone];
  const words = (
    <span
      className={cn(
        "inline-flex items-start gap-1.5",
        tone === "yes"
          ? "text-foreground"
          : tone === "no"
            ? "text-warning-text"
            : "text-muted-foreground",
      )}
    >
      {Mark !== undefined && (
        <Mark
          aria-hidden
          className={cn("mt-px size-icon-row shrink-0", tone === "yes" && "text-success-text")}
        />
      )}
      <span>
        {ability.text}
        {ability.detail !== undefined && <span className="sr-only"> {ability.detail}</span>}
      </span>
    </span>
  );
  return (
    <td className="px-2.5 py-2">
      <span aria-hidden className="mb-0.5 hidden text-muted-foreground @max-md:block">
        {column}
      </span>
      {ability.detail === undefined ? (
        words
      ) : (
        <Hint
          label={ability.detail}
          render={<span tabIndex={0} className={cn("rounded-sm", FOCUS_RING)} />}
        >
          {words}
        </Hint>
      )}
      {fix !== undefined && (
        <a
          href={fix.href}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block text-link underline-offset-2 hover:underline"
        >
          {fix.label}
        </a>
      )}
    </td>
  );
}

function AccessFoot({
  note,
  link,
  offGitHub,
}: {
  note: string | undefined;
  link: { readonly label: string; readonly href: string } | undefined;
  offGitHub: number;
}) {
  const links = link === undefined ? [] : [link];
  if (note === undefined && links.length === 0 && offGitHub === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted-foreground">
      {note !== undefined && <span>{note}</span>}
      {offGitHub > 0 && (
        <span>
          {offGitHub === 1
            ? "One repository isn't on GitHub, so nothing here covers it."
            : `${offGitHub} repositories aren't on GitHub, so nothing here covers them.`}
        </span>
      )}
      {links.map((each) => (
        <a
          key={each.href + each.label}
          href={each.href}
          target="_blank"
          rel="noreferrer"
          className="text-link underline-offset-2 hover:underline"
        >
          {each.label}
        </a>
      ))}
    </p>
  );
}
