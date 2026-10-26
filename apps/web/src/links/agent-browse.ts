import { useEffect, useState } from "react";

/** The shell's "Agent may browse" list; the mock's in e2e, and none in a browser, which has no pane. */
const shellList = () =>
  typeof window === "undefined"
    ? undefined
    : (window.gram?.agentBrowse ?? window.gramMock?.shell.agentBrowse);

/**
 * The public hosts agents may browse in the Preview pane without asking, and a way to stop
 * approving one. `hosts` is `undefined` until the shell has answered.
 */
export function useAgentBrowseHosts(): {
  hosts: readonly string[] | undefined;
  remove(host: string): void;
} {
  const shell = shellList();
  const [hosts, setHosts] = useState<readonly string[]>();
  useEffect(() => {
    if (shell === undefined) return;
    let live = true;
    const unsubscribe = shell.onChange(setHosts);
    shell.list().then(
      (list) => {
        if (live) setHosts(list);
      },
      (error: unknown) => console.error("agent browse", error),
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [shell]);
  return {
    hosts,
    remove: (host) => {
      shell?.remove(host).catch((error: unknown) => console.error("agent browse", error));
    },
  };
}
