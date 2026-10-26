import type { ThreadId } from "@gram/contracts";
import { GitPullRequest } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";

import { targetBadge } from "../pr-identity";
import { bindPrFromInput } from "./pr-bind";
import { parsePrRef } from "./pr-ref";
import { Notice, useReviewAction } from "./review-thread-card";
import { ToggleSwitch } from "./toggle-switch";

const inputCls =
  "h-7 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Binding, unbinding and watching CI on the thread's PR, shared by the binding strip and the watch row. */
export function usePrBinding(threadId: ThreadId) {
  const api = useApi();
  const boundPr = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr);
  const origin = useThreadsStore((s) => s.byId[threadId]?.git?.origin);
  const branchPr = useThreadsStore((s) => s.byId[threadId]?.git?.pr);
  const action = useReviewAction();
  const boundUrl = targetBadge({ pr: branchPr, origin }, boundPr)?.url;

  /** Binds the PR `value` names, then calls `onBound`; a failure stays in `action.notice`. */
  const bind = (value: string, onBound: () => void) =>
    action.run(async () => {
      await bindPrFromInput(api, threadId, value, origin);
      onBound();
      return undefined;
    });

  const watchCi = () =>
    action.run(async () => {
      if (boundPr) {
        await api.prSetMonitor(threadId, !boundPr.monitor);
        return undefined;
      }
      if (!branchPr) return undefined;
      const repo = origin ?? parsePrRef(branchPr.url)?.repo;
      if (repo === undefined) throw new Error("Couldn't tell which repository this PR is in");
      await api.prBind(threadId, repo, branchPr.number, true);
      return undefined;
    });

  const unbind = () =>
    action.run(async () => {
      await api.prUnbind(threadId);
      return undefined;
    });

  return {
    boundPr,
    boundUrl,
    hasPr: boundPr !== undefined || branchPr !== undefined,
    action,
    bind,
    watchCi,
    unbind,
  };
}

/** "Following owner/repo#n", linking to the PR when its badge has a URL, and Unbind. */
export function FollowingStatus({ binding }: { binding: ReturnType<typeof usePrBinding> }) {
  const api = useApi();
  const { boundPr, boundUrl, action, unbind } = binding;
  if (!boundPr) return null;
  return (
    <>
      <span
        data-testid="pr-binding-status"
        className="flex min-w-0 items-center gap-1 text-muted-foreground"
      >
        <GitPullRequest aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          Following{" "}
          {boundUrl === undefined ? (
            `${boundPr.repo}#${boundPr.number}`
          ) : (
            <button
              type="button"
              title="Open on GitHub"
              onClick={() => void openExternalUrl(api, boundUrl)}
              className="rounded-sm text-link underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {boundPr.repo}#{boundPr.number}
            </button>
          )}
        </span>
      </span>
      <Button
        size="xs"
        variant="ghost"
        className="ml-auto"
        disabled={action.pending}
        onClick={() => void unbind()}
      >
        Unbind
      </Button>
    </>
  );
}

/** The PR number or URL to bind, with Bind and Cancel. */
export function BindPrForm({
  binding,
  onDone,
}: {
  binding: ReturnType<typeof usePrBinding>;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const { action, bind } = binding;
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        void bind(value, onDone);
      }}
    >
      <input
        aria-label="Pull request number or URL"
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={inputCls}
        placeholder="#12 or https://github.com/owner/repo/pull/12"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
        }}
      />
      <Button type="submit" size="xs" disabled={action.pending || !value.trim()}>
        Bind
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * The PR the thread follows when the panel has no PR detail to show: bind one by number or URL,
 * unbind it, and watch its CI. While nothing is bound, watching CI binds the branch's PR.
 */
export function PrBinding({ threadId }: { threadId: ThreadId }) {
  const binding = usePrBinding(threadId);
  const { boundPr, hasPr, action, watchCi } = binding;
  const [formOpen, setFormOpen] = useState(false);

  return (
    <div data-testid="pr-binding" className="flex flex-col gap-1 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {hasPr && (
          <>
            <ToggleSwitch
              on={boundPr?.monitor ?? false}
              label="Watch CI"
              disabled={action.pending}
              onToggle={() => void watchCi()}
            />
            <span className="font-medium">Watch CI</span>
          </>
        )}
        {boundPr ? (
          <FollowingStatus binding={binding} />
        ) : (
          !formOpen && (
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              disabled={action.pending}
              onClick={() => setFormOpen(true)}
            >
              Bind a PR…
            </Button>
          )
        )}
      </div>
      {formOpen && !boundPr && <BindPrForm binding={binding} onDone={() => setFormOpen(false)} />}
      <Notice notice={action.notice} />
    </div>
  );
}
