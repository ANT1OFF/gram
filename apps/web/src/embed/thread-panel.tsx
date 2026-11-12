import type { ThreadId } from "@gram/contracts";
import { lazy, Suspense, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PanelMessage } from "@/panels/panel-message";
import { useThreadsStore } from "@/stores/threads";

import type { ShellThreadPanelComponent, ShellThreadPanelTab } from "./contract";

// A thread's working panels for a page of the embedding app's: what the right panel shows on the
// thread's own page, without the panel's other tabs, its toggle or its place in the layout. The
// panels are the app's own, loaded when first shown, as the right panel loads them.

const DiffPanel = lazy(() => import("@/panels/diff-panel").then((m) => ({ default: m.DiffPanel })));
const PrPanel = lazy(() => import("@/panels/pr-panel").then((m) => ({ default: m.PrPanel })));
const FilesPanel = lazy(() =>
  import("@/panels/files/files-panel").then((m) => ({ default: m.FilesPanel })),
);
const TerminalPanel = lazy(() =>
  import("@/panels/terminal/terminal-panel").then((m) => ({ default: m.TerminalPanel })),
);

const TABS: readonly { readonly value: ShellThreadPanelTab; readonly label: string }[] = [
  { value: "diff", label: "Diff" },
  { value: "pr", label: "Pull request" },
  { value: "files", label: "Files" },
  { value: "terminal", label: "Terminal" },
];

export const ShellThreadPanel: ShellThreadPanelComponent = ({ threadId, tab, onTabChange }) => {
  const [own, setOwn] = useState<ShellThreadPanelTab>("diff");
  const shown = tab ?? own;
  const id = threadId as ThreadId;
  // A thread the server no longer has has no diff, files or terminal to show.
  const known = useThreadsStore((s) => !s.ready || s.byId[id] !== undefined);
  return (
    <Tabs
      value={shown}
      onValueChange={(value) => {
        const next = value as ShellThreadPanelTab;
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
        {!known ? (
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
