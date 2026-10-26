import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { whatsNewAudience, type WhatsNewRelease } from "./index";
import { ReleaseNotes } from "./release-notes";

export const useWhatsNewDialog = create<{
  releases: readonly WhatsNewRelease[] | undefined;
  /** Whether this launch's check showed the screen; undefined until it has decided. */
  launch: "shown" | "quiet" | undefined;
  show: (releases: readonly WhatsNewRelease[]) => void;
  close: () => void;
}>()((set) => ({
  releases: undefined,
  launch: undefined,
  show: (releases) => set({ releases }),
  close: () => set({ releases: undefined }),
}));

/** The What's New screen: shown once after an update, and again from Settings → Help. */
export function WhatsNewDialog() {
  const releases = useWhatsNewDialog((s) => s.releases);
  const close = useWhatsNewDialog((s) => s.close);
  if (!releases) return null;
  const audience = whatsNewAudience(window.gram);

  return (
    <DialogShell testId="whats-new-dialog" title="What's new in Gram" onClose={close}>
      <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto text-sm">
        <ReleaseNotes releases={releases} audience={audience} />
      </div>
      <div className="flex justify-end">
        <Dialog.Close render={<Button type="button" size="sm" />}>Got it</Dialog.Close>
      </div>
    </DialogShell>
  );
}
