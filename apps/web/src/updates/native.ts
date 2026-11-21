import type { AppUpdateState, UpdateChannel } from "@gram/contracts";

import { useUpdateStore } from "./store";

const act = async (
  run: (
    native: NonNullable<NonNullable<Window["gram"]>["updates"]["native"]>,
  ) => Promise<AppUpdateState | null>,
): Promise<void> => {
  const native = window.gram?.updates.native;
  if (!native) return;
  const state = await run(native);
  if (state) useUpdateStore.setState({ native: state });
};

export const nativeUpdates = {
  check: (channel: UpdateChannel) => act((native) => native.check(channel)),
  download: () => act((native) => native.download()),
  install: (version: string) => act((native) => native.install(version)),
  dismiss: () => act((native) => native.dismiss()),
};

/** Reads main's state once and follows it; returns the unsubscribe function. */
export function followNativeUpdates(): () => void {
  const native = window.gram?.updates.native;
  if (!native) {
    useUpdateStore.setState({ native: null });
    return () => {};
  }
  let live = true;
  const stop = native.onState((state) => useUpdateStore.setState({ native: state }));
  native.state().then(
    (state) => {
      if (live) useUpdateStore.setState({ native: state });
    },
    (error: unknown) => console.error("updates: read the signed updater's state", error),
  );
  return () => {
    live = false;
    stop();
  };
}
