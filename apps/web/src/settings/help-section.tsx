import { useState } from "react";

import { Button } from "@/components/ui/button";
import { compareVersionBase, WHATS_NEW, whatsNewAudience } from "@/whats-new";
import { ReleaseNotes } from "@/whats-new/release-notes";
import { useWhatsNewDialog } from "@/whats-new/whats-new-dialog";

import { LONG_COPY } from "./fields";
import { useDiagnostics } from "./use-diagnostics";

/**
 * Settings → What's New: the running version, each release's highlights, the screen again, and the
 * third-party notices the desktop app ships.
 */
export function HelpSection() {
  const { data: info } = useDiagnostics();
  const audience = whatsNewAudience(window.gram);
  const openAcknowledgements = window.gram?.openAcknowledgements;
  const [noticesError, setNoticesError] = useState<string>();

  const showAcknowledgements = async () => {
    const opened = await openAcknowledgements?.().catch(() => false);
    setNoticesError(opened ? undefined : "Couldn't open the third-party notices in this install.");
  };

  const showScreen = () => {
    const shipped = info
      ? WHATS_NEW.filter((release) => compareVersionBase(release.version, info.version) <= 0)
      : [];
    useWhatsNewDialog.getState().show(shipped.length > 0 ? shipped : WHATS_NEW);
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="whats-new">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground">
          {info ? `You're running Gram ${info.version}.` : "Gram"}
        </p>
        <Button size="sm" variant="outline" onClick={showScreen}>
          Show What's New
        </Button>
        {openAcknowledgements && (
          <Button size="sm" variant="ghost" onClick={() => void showAcknowledgements()}>
            Acknowledgements
          </Button>
        )}
      </div>
      {noticesError && (
        <p role="alert" className="text-muted-foreground">
          {noticesError}
        </p>
      )}
      <div {...{ [LONG_COPY]: "release notes" }}>
        <ReleaseNotes releases={WHATS_NEW} audience={audience} />
      </div>
    </div>
  );
}
