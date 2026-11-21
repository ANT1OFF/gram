import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderGit2, SquareDashed } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { EmbedHome } from "@/embed/slots";
import { useHostHome } from "@/embed/store";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { useLandOnOrchestrator } from "@/orchestration/home";
import { useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { useThreadsStore } from "@/stores/threads";
import { Welcome } from "@/welcome/welcome";
import { useFirstRun } from "@/welcome/welcome-state";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return useHostHome() ? <EmbedHome /> : <GramHome />;
}

function GramHome() {
  const deciding = useLandOnOrchestrator();
  const firstRun = useFirstRun();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!deciding && (
        <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
          {firstRun ? <Welcome /> : <HomeEmpty />}
        </div>
      )}
    </div>
  );
}

function HomeEmpty() {
  const navigate = useNavigate();
  const { workspaces, settled } = useWorkspacesQuery();
  const noThreads = useThreadsStore((s) => Object.keys(s.byId).length === 0);
  if (settled && workspaces.length === 0 && noThreads) {
    return (
      <EmptyState
        testId="home-empty"
        icon={FolderGit2}
        title="No workspaces yet"
        line="Open a repository to make one: its orchestrator hands your tasks to agents."
        action={{
          label: "Open a repository",
          testId: "home-open-repository",
          primary: true,
          onClick: () => void navigate({ to: "/new-workspace" }),
        }}
      />
    );
  }
  return (
    <EmptyState
      testId="home-empty"
      icon={SquareDashed}
      title="No thread open"
      line="Pick one in the sidebar, or start a new task."
      action={{
        label: (
          <>
            New task
            <ShortcutKbd id="thread.new" cap />
          </>
        ),
        testId: "home-new-task",
        onClick: () => void navigate({ to: "/new" }),
      }}
    />
  );
}
