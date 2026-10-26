import { trustedHostsOf } from "@gram/contracts";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface PageTrustState {
  hosts: readonly string[];
  add(host: string): void;
  remove(host: string): void;
}

/**
 * The trusted hosts in a browser, where the page opens links itself and so is the one that asks.
 * The desktop app keeps its list in the shell instead (see `DesktopBridge.trustedLinks`).
 */
export const usePageTrustedLinks = create<PageTrustState>()(
  persist(
    (set) => ({
      hosts: [],
      add: (host) => set((s) => ({ hosts: trustedHostsOf([...s.hosts, host]) })),
      remove: (host) => set((s) => ({ hosts: s.hosts.filter((h) => h !== host) })),
    }),
    {
      name: "gram.trustedLinks",
      version: 1,
      storage: createJSONStorage(() => globalThis.localStorage),
      partialize: ({ hosts }) => ({ hosts }),
      merge: (persisted, current) => ({
        ...current,
        hosts: trustedHostsOf((persisted as { hosts?: unknown } | undefined)?.hosts),
      }),
    },
  ),
);

/** The shell's list, when the desktop app asks about links itself; `undefined` in a browser. */
const shellTrust = () => (typeof window === "undefined" ? undefined : window.gram?.trustedLinks);

/** Whether the desktop shell asks before a link opens, so the page mustn't ask as well. */
export const shellAsksAboutLinks = () => shellTrust() !== undefined;

/**
 * The hosts whose links open without asking, wherever they're kept, and a way to stop trusting
 * one. `hosts` is `undefined` until the shell has answered.
 */
export function useTrustedLinks(): {
  hosts: readonly string[] | undefined;
  remove(host: string): void;
} {
  const shell = shellTrust();
  const page = usePageTrustedLinks();
  const [shellHosts, setShellHosts] = useState<readonly string[]>();
  useEffect(() => {
    if (shell === undefined) return;
    let live = true;
    const unsubscribe = shell.onChange(setShellHosts);
    shell.list().then(
      (hosts) => {
        if (live) setShellHosts(hosts);
      },
      (error: unknown) => console.error("trusted links", error),
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [shell]);
  if (shell === undefined) return { hosts: page.hosts, remove: page.remove };
  return {
    hosts: shellHosts,
    remove: (host) => {
      shell.remove(host).catch((error: unknown) => console.error("trusted links", error));
    },
  };
}
