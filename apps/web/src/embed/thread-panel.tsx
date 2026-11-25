import { ThreadId } from "@gram/contracts";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PanelMessage } from "@/panels/panel-message";
import { useThreadsStore } from "@/stores/threads";

import type { ShellThreadPanelComponent, ShellThreadPanelTab } from "./contract";

const DiffPanel = lazy(() => import("@/panels/diff-panel").then((m) => ({ default: m.DiffPanel })));
const PrPanel = lazy(() => import("@/panels/pr-panel").then((m) => ({ default: m.PrPanel })));
const FilesPanel = lazy(() =>
  import("@/panels/files/files-panel").then((m) => ({ default: m.FilesPanel })),
);
const TerminalPanel = lazy(() =>
  import("@/panels/terminal/terminal-panel").then((m) => ({ default: m.TerminalPanel })),
);

const isThreadId = Schema.is(ThreadId);

const TABS: readonly { readonly value: ShellThreadPanelTab; readonly label: string }[] = [
  { value: "diff", label: "Diff" },
  { value: "pr", label: "Pull request" },
  { value: "files", label: "Files" },
  { value: "terminal", label: "Terminal" },
];

export const ShellThreadPanel: ShellThreadPanelComponent = ({ threadId, tab, onTabChange }) => {
  const [own, setOwn] = useState<ShellThreadPanelTab>("diff");
  const shown = tab ?? own;
  const id = isThreadId(threadId) ? threadId : undefined;
  const known = useThreadsStore((s) => id !== undefined && (!s.ready || s.byId[id] !== undefined));
  return (
    <Tabs
      value={shown}
      onValueChange={(value) => {
        const next = TABS.find((entry) => entry.value === value)?.value;
        if (next === undefined) return;
        setOwn(next);
        onTabChange?.(next);
      }}
      className="flex h-full min-h-0 flex-col"
      data-testid="shell-thread-panel"
    >
      <TabsList>
        {TABS.map((entry) => (
          <TabsTrigger key={entry.value} value={entry.value} data-shell-panel-tab={entry.value}>
            {entry.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <Suspense fallback={null}>
        {!known || id === undefined ? (
          <PanelMessage>This thread no longer exists.</PanelMessage>
        ) : (
          <>
            <TabsContent value="diff" className="flex min-h-0 flex-col">
              <DiffPanel key={id} threadId={id} />
            </TabsContent>
            <TabsContent value="pr" className="flex min-h-0 flex-col">
              <PrPanel key={id} threadId={id} />
            </TabsContent>
            <TabsContent value="files" className="flex min-h-0 flex-col">
              <FilesPanel key={id} threadId={id} />
            </TabsContent>
            <TabsContent value="terminal" className="flex min-h-0 flex-col">
              <TerminalPanel key={id} threadId={id} />
            </TabsContent>
          </>
        )}
      </Suspense>
    </Tabs>
  );
};
