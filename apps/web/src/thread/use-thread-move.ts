import { embeddingOn, type HostedDeviceView } from "@gram/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { MoveTarget } from "@/orchestration/move-targets";
import { useServerSettings } from "@/settings-sync/store";

import { threadMoveTargets } from "./move-thread-model";

type Bridge = NonNullable<NonNullable<Window["gram"]>["hostedDevice"]>;
export type ThreadMover = NonNullable<Bridge["moveThread"]>;

/**
 * Whether a thread can be offered a move at all, where to, and the shell's call that sends it:
 * only with the hosted features on, in a desktop app that can send one. `view` is undefined while
 * it is read.
 */
export function useThreadMove(): {
  readonly mover: ThreadMover | undefined;
  readonly view: HostedDeviceView | null | undefined;
  readonly targets: readonly MoveTarget[];
} {
  const hosted = useServerSettings((s) => s.settings !== undefined && embeddingOn(s.settings));
  const bridge = typeof window === "undefined" ? undefined : window.gram?.hostedDevice;
  const mover = hosted ? bridge?.moveThread : undefined;
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
  const targets = useMemo(
    () => (mover === undefined ? [] : threadMoveTargets(view)),
    [mover, view],
  );
  return { mover, view, targets };
}
