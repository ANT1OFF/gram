import type { Thread } from "@gram/contracts";
import { ChevronRight, CircleCheck, CircleMinus, CircleX } from "lucide-react";
import { PendingRing } from "@/motion";
import { cn } from "@/lib/utils";
import { basename } from "./parts";

const display = {
  running: { icon: PendingRing, label: "running", tone: "text-status-working" },
  passed: { icon: CircleCheck, label: "passed", tone: "text-success" },
  reused: { icon: CircleCheck, label: "reused", tone: "text-success" },
  failed: { icon: CircleX, label: "failed", tone: "text-destructive" },
  skipped: { icon: CircleMinus, label: "skipped", tone: "text-muted-foreground" },
};

export function WorktreeHookNotice({ thread }: { thread: Thread }) {
  const items = (thread.worktreeHooks ?? []).filter((hook) => hook.result.status !== "absent");
  if (items.length === 0) return null;
  const checkouts = [thread.checkout, ...(thread.extraCheckouts ?? [])];
  return (
    <aside
      aria-label="Worktree hooks"
      className="thread-column w-full shrink-0 space-y-1 px-6 py-1"
    >
      {items.map(({ checkout, generation, kind, path, result }) => {
        if (result.status === "absent") return null;
        const { icon: Icon, label, tone } = display[result.status];
        const phase = kind === "setup" ? "Setup" : "Resume";
        const repo = checkouts.find((each) => each.path === checkout);
        const repository = basename(repo?.repoRoot ?? checkout);
        const row = (
          <>
            <Icon aria-hidden className={cn("size-icon-row shrink-0", tone)} />
            <span className="shrink-0">
              {phase} {label}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">{repository}</span>
          </>
        );
        const key = [checkout, generation, kind].join(":");
        const rowClass = "flex min-h-8 items-center gap-2 px-2 text-meta";
        if (result.status === "running")
          return (
            <div key={key} className={rowClass}>
              {row}
            </div>
          );
        return (
          <details key={key} className="group rounded-md border border-edge bg-card">
            <summary
              className={cn(
                rowClass,
                "cursor-pointer list-none rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden",
              )}
            >
              {row}
              {result.durationMs > 0 && (
                <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                  {(result.durationMs / 1000).toFixed(1)} s
                </span>
              )}
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-icon-chip shrink-0 text-muted-foreground group-open:rotate-90",
                  result.durationMs <= 0 && "ml-auto",
                )}
              />
            </summary>
            <div className="space-y-1 px-2 pb-2 text-meta">
              {path !== undefined && <p className="font-mono text-muted-foreground">{path}</p>}
              {result.reason !== undefined && <p>{result.reason}</p>}
              {result.log !== "" && (
                <pre
                  aria-label={`${phase} log`}
                  className="max-h-48 overflow-auto rounded-sm bg-muted p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]"
                >
                  {result.log}
                </pre>
              )}
            </div>
          </details>
        );
      })}
    </aside>
  );
}
