import { createFileRoute, Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { useLandOnOrchestrator } from "@/orchestration/home";
import { useFirstRun, Welcome } from "@/welcome/welcome";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  // A launch with a workspace goes on to its orchestrator; nothing shows until that's decided.
  const deciding = useLandOnOrchestrator();
  const firstRun = useFirstRun();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!deciding && (
        <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6 text-sm text-muted-foreground">
          {firstRun ? (
            <Welcome />
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p>Select a thread, or start a new one.</p>
              {/* With nothing in the sidebar yet, this is the way in. */}
              <Button size="sm" variant="outline" render={<Link to="/new" />} nativeButton={false}>
                New task
                <ShortcutKbd id="thread.new" className="text-muted-foreground" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
