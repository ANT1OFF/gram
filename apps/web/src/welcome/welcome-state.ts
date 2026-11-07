import { useEffect } from "react";
import { create } from "zustand";

import { useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

// Whether the first run shows, apart from the welcome screen itself, which the shell's sidebar and
// title bar ask about on every launch and only a first run draws.

/**
 * Whether this app session shows the first-run screen; decided once, when settings first load, so
 * picking a repository that happens to mark it seen can't close it under the user.
 */
export const useWelcome = create<{ open: boolean | undefined }>()(() => ({ open: undefined }));

/** Whether the first-run screen shows: a first run, while no workspace exists. */
export function useFirstRun(): boolean {
  const settings = useServerSettings((s) => s.settings);
  const open = useWelcome((s) => s.open);
  const { workspaces, settled } = useWorkspacesQuery();
  useEffect(() => {
    if (!settings || useWelcome.getState().open !== undefined) return;
    useWelcome.setState({ open: !settings.onboarding.welcomeSeen });
  }, [settings]);
  return open === true && settled && workspaces.length === 0;
}

/**
 * Before any setup: the first run, with no thread yet. What only means something once there is
 * work (pull requests, usage, what needs you) stays away, so the welcome is the one thing to look
 * at.
 */
export function useBeforeSetup(): boolean {
  const firstRun = useFirstRun();
  const empty = useThreadsStore((s) => Object.keys(s.byId).length === 0);
  return firstRun && empty;
}
