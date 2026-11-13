// Where a workspace can move, apart from the sheet that moves it: a workspace's menu asks this on
// the first screen, and the sheet loads only when it opens.
import { embeddingOn, type HostedDeviceView } from "@gram/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useServerSettings } from "@/settings-sync/store";

type Bridge = NonNullable<NonNullable<Window["gram"]>["hostedDevice"]>;
export type Mover = NonNullable<Bridge["move"]>;

/** A workspace of a server signed in to, as a place a workspace here can move to. */
export interface MoveTarget {
  readonly origin: string;
  /** The server's address as a person reads it: its host. */
  readonly host: string;
  readonly workspace: string;
  /** The workspace's name there, in the server's words. */
  readonly name: string;
  readonly organisation: string;
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Where a workspace can move: every workspace of every server signed in to and not paused, that
 * is not read-only for this person there. None while there is no sign-in.
 */
export const moveTargets = (view: HostedDeviceView | null | undefined): readonly MoveTarget[] =>
  (view?.servers ?? [])
    .filter((server) => server.signedIn && !server.paused)
    .flatMap((server) =>
      server.workspaces
        .filter((workspace) => !workspace.readOnly)
        .map((workspace) => ({
          origin: server.origin,
          host: hostOf(server.origin),
          workspace: workspace.id,
          name: workspace.name,
          organisation: workspace.organisation,
        })),
    );

/** One target's key in a list of them: a server may have two workspaces of one name. */
export const targetKey = (target: Pick<MoveTarget, "origin" | "workspace">): string =>
  `${target.origin} ${target.workspace}`;

/**
 * Where a workspace of this machine can move, and the shell's calls that move it: none unless the
 * hosted features are on, the desktop app can move one, and a server is signed in to.
 */
export function useMoveTargets(): {
  readonly targets: readonly MoveTarget[];
  readonly mover: Mover | undefined;
} {
  const hosted = useServerSettings((s) => s.settings !== undefined && embeddingOn(s.settings));
  const bridge = typeof window === "undefined" ? undefined : window.gram?.hostedDevice;
  const mover = hosted ? bridge?.move : undefined;
  const [view, setView] = useState<HostedDeviceView | null>();
  const read = useCallback(() => {
    if (bridge === undefined || mover === undefined) return;
    void bridge.state().then(setView, () => setView(null));
  }, [bridge, mover]);
  useEffect(() => {
    if (bridge === undefined || mover === undefined) return undefined;
    read();
    return bridge.onChange(read);
  }, [bridge, mover, read]);
  const targets = useMemo(() => (mover === undefined ? [] : moveTargets(view)), [mover, view]);
  return { targets, mover };
}
