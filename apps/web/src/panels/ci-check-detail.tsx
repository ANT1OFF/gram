import {
  actionsJobSelection,
  repoFromPrUrl,
  type CiDiagnosticSelection,
  type CiJobDiagnostic,
  type PrCheckRun,
  type ThreadId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { formatMessageTime } from "@/lib/time";

/** Expansion is the only fetch trigger; evidence has no persisted cache or automatic retries. */
export function CiCheckDetail({
  threadId,
  prUrl,
  prNumber,
  headOid,
  check,
}: {
  threadId: ThreadId;
  prUrl: string;
  prNumber: number;
  headOid?: string | undefined;
  check: PrCheckRun;
}) {
  const repo = repoFromPrUrl(prUrl);
  const job = repo ? actionsJobSelection(check.link, repo) : undefined;
  const [open, setOpen] = useState(false);
  if (
    (check.status !== "failing" &&
      check.status !== "pending" &&
      check.conclusion?.toUpperCase() !== "CANCELLED") ||
    !job ||
    !headOid ||
    !/^[a-f0-9]{40}$/i.test(headOid)
  )
    return null;
  return (
    <div className="w-full ps-5 text-xs">
      <button
        type="button"
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground underline underline-offset-2"
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide" : "Inspect"} {check.name} job
      </button>
      {open && (
        <JobEvidence
          key={`${threadId}:${prUrl}:${headOid}:${check.link}`}
          threadId={threadId}
          repo={repo!}
          selection={{
            repo: repo!,
            number: prNumber,
            headOid,
            ...job,
          }}
        />
      )}
    </div>
  );
}

function JobEvidence({
  threadId,
  repo,
  selection,
}: {
  threadId: ThreadId;
  repo: string;
  selection: CiDiagnosticSelection;
}) {
  const api = useApi();
  const [includeLog, setIncludeLog] = useState(false);
  const metadata = useQuery({
    queryKey: ["git.prCheckDiagnostic", threadId, repo, selection],
    queryFn: () => api.prCheckDiagnostic(threadId, selection),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const excerpt = useQuery({
    queryKey: ["git.prCheckDiagnostic.log", threadId, repo, selection, metadata.data?.attempt],
    queryFn: () =>
      api.prCheckDiagnostic(threadId, {
        ...selection,
        attempt: metadata.data!.attempt,
        includeLog: true,
      }),
    enabled: includeLog && metadata.data !== undefined,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = includeLog ? excerpt.data : metadata.data;
  const error = metadata.isError || (includeLog && excerpt.isError);
  const matches = (value: CiJobDiagnostic) =>
    value.repo.toLowerCase() === repo.toLowerCase() &&
    value.number === selection.number &&
    value.headOid === selection.headOid &&
    value.runId === selection.runId &&
    value.jobId === selection.jobId &&
    (!includeLog || value.attempt === metadata.data?.attempt);
  if (error || (data && !matches(data)))
    return (
      <p role="alert" className="py-2">
        CI evidence unavailable or changed. Refresh the PR or inspect the job on GitHub.
      </p>
    );
  if (!data)
    return (
      <p role="status" className="py-2">
        {includeLog ? "Reading bounded log excerpt…" : "Reading job metadata…"}
      </p>
    );
  return (
    <div
      className="my-2 flex flex-col gap-1.5 rounded border border-border p-2"
      data-testid="ci-job-detail"
    >
      <p>{data.explanation}</p>
      <p className="break-all font-mono text-muted-foreground">
        Head {data.headOid} · Run {data.runId} · Attempt {data.attempt} · Job {data.jobId}
      </p>
      <p>
        {data.conclusion ?? data.status}
        {data.runner ? ` · Runner ${data.runner}` : " · Runner not exposed by GitHub"}
      </p>
      {data.startedAt && (
        <p>
          Started{" "}
          <time dateTime={data.startedAt}>{formatMessageTime(Date.parse(data.startedAt))}</time>
        </p>
      )}
      {data.completedAt && (
        <p>
          Finished{" "}
          <time dateTime={data.completedAt}>{formatMessageTime(Date.parse(data.completedAt))}</time>
        </p>
      )}
      {data.failingStep && <p>Step: {data.failingStep}</p>}
      {data.evidence.map((e, i) => (
        <div key={i}>
          <span className="text-muted-foreground">
            {e.source === "annotation" ? "GitHub annotation" : "Log excerpt"}
          </span>
          <pre className="whitespace-pre-wrap break-all font-mono">{e.text}</pre>
        </div>
      ))}
      {data.evidence.length === 0 && (
        <p className="text-muted-foreground">No diagnostic evidence returned.</p>
      )}
      {data.note && <p className="text-muted-foreground">{data.note}</p>}
      <div className="flex flex-wrap gap-3">
        <a
          href={`https://github.com/${repo}/actions/runs/${data.runId}/job/${data.jobId}`}
          className="underline underline-offset-2"
          onClick={(e) => {
            e.preventDefault();
            void openExternalUrl(api, e.currentTarget.href).catch(() => {});
          }}
        >
          Inspect {data.name} on GitHub
        </a>
        {!includeLog && data.status === "completed" && (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setIncludeLog(true)}
          >
            Read redacted log excerpt
          </button>
        )}
      </div>
    </div>
  );
}
