import { useEffect } from "react";

import { useApi } from "@/api/context";
import { registerShortcut } from "@/keyboard/registry";
import { useLayoutStore } from "@/stores/layout";

import { startScript, useProjectScripts, useThreadProject } from "./use-project-scripts";

/**
 * Each project script's own key, for the focused pane's thread: pressing it runs the script in that
 * thread's folder, as picking it from Run script does. Mounted once, beside the thread dialogs.
 */
export function ScriptShortcuts() {
  const api = useApi();
  const threadId = useLayoutStore((s) => s.grid.panes[s.grid.focused] ?? undefined);
  const projectId = useThreadProject(threadId);
  const { data } = useProjectScripts(projectId);

  useEffect(() => {
    if (threadId === undefined || data === undefined || data.projectId !== projectId) return;
    const unregister = data.scripts.flatMap((script) =>
      script.shortcut === undefined
        ? []
        : [
            registerShortcut({
              id: `script.${script.name}`,
              keys: script.shortcut,
              label: `Run ${script.name}`,
              group: "Thread",
              run: () => startScript(api, threadId, script.name),
            }),
          ],
    );
    return () => {
      for (const each of unregister) each();
    };
  }, [api, threadId, projectId, data]);

  return null;
}
