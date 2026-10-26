import type { TerminalId, ThreadId } from "@gram/contracts";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";

import { TerminalView } from "./terminal-view";
import {
  closeTerminal,
  ensureTerminals,
  openTerminal,
  restartTerminal,
  terminalProblem,
  useTerminalsStore,
} from "./terminals-store";

/** The thread's terminals: one by default, more via "New terminal", each in its own tab. */
export function TerminalPanel({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const entry = useTerminalsStore((s) => s.byThread[threadId]);
  const setActive = useTerminalsStore((s) => s.setActive);
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    ensureTerminals(api, threadId).catch((error: unknown) => {
      if (!cancelled) setProblem(terminalProblem(error));
    });
    return () => {
      cancelled = true;
    };
  }, [api, threadId]);

  const panelRef = useRef<HTMLDivElement>(null);

  const report = (error: unknown) => setProblem(terminalProblem(error));
  const newTerminal = () => {
    setProblem(undefined);
    openTerminal(api, threadId).catch(report);
  };
  const closeTab = (id: TerminalId) => {
    void closeTerminal(api, threadId, id);
    // The close button leaves with its tab: keep focus in the tab strip.
    setTimeout(() => {
      if (!focusLost()) return;
      const panel = panelRef.current;
      (
        panel?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
        panel?.querySelector<HTMLElement>('[aria-label="New terminal"]')
      )?.focus();
    }, 0);
  };

  if (!entry) {
    return problem ? (
      <div className="flex flex-col items-center">
        <PanelMessage>{problem}</PanelMessage>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            setProblem(undefined);
            ensureTerminals(api, threadId).catch(report);
          }}
        >
          Retry
        </Button>
      </div>
    ) : (
      <PanelMessage>
        <Shimmer>Starting a terminal…</Shimmer>
      </PanelMessage>
    );
  }

  return (
    <div ref={panelRef} data-testid="terminal-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto"
        >
          {entry.ids.map((id, index) => {
            const selected = id === entry.active;
            return (
              <div
                key={id}
                className={cn(
                  "flex shrink-0 items-center rounded-md text-xs text-muted-foreground",
                  selected && "bg-muted text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActive(threadId, id)}
                  className="rounded-md px-2 py-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Terminal {index + 1}
                </button>
                <button
                  type="button"
                  aria-label={`Close terminal ${index + 1}`}
                  onClick={() => closeTab(id)}
                  className="rounded-sm p-0.5 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="New terminal"
          onClick={newTerminal}
        >
          <Plus />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {entry.ids.length === 0 && <PanelMessage>No terminals. Open one with +.</PanelMessage>}
        {entry.ids.map((id) => (
          <TerminalView
            key={id}
            threadId={threadId}
            terminalId={id}
            shell={entry.shells[id]}
            active={id === entry.active}
            onRestart={() => restartTerminal(api, threadId, id).catch(report)}
          />
        ))}
      </div>
      {problem && (
        <p role="alert" className="border-t border-border px-2 py-1.5 text-xs text-danger-text">
          {problem}
        </p>
      )}
    </div>
  );
}
