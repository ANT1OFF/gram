import type { WorkspaceId } from "@gram/contracts";
import { Info } from "lucide-react";
import { useMemo } from "react";

import { noCiRepos, noCiText } from "./no-ci-model";
import { useOrchestratorLedger } from "./use-orchestration";

/** The workspace's repos with no CI, in one muted line; nothing when every repo has some. */
export function NoCiNote({
  workspaceId,
  className,
}: {
  workspaceId: WorkspaceId;
  className?: string;
}) {
  const ledger = useOrchestratorLedger(workspaceId).data;
  const repos = useMemo(() => noCiRepos(ledger), [ledger]);
  if (repos.length === 0) return null;
  const text = noCiText(repos);
  return (
    <div className={className}>
      <p
        data-testid="board-no-ci"
        data-repos={repos.map((each) => each.repo).join(" ")}
        title={text}
        className="flex min-w-0 items-start gap-1.5 text-meta text-muted-foreground"
      >
        <Info aria-hidden className="mt-0.5 size-icon-row shrink-0" />
        <span className="min-w-0">{text}</span>
      </p>
    </div>
  );
}
