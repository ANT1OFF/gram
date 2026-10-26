import { useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useServerSettings } from "@/settings-sync/store";

import { ConfirmStrip } from "./confirm-strip";
import { changedSettings, listLabels, restorePatch, type DefaultSetting } from "./defaults";
import { ExpandableError, WhyDisabled } from "./fields";
import { useSaveSettings } from "./use-save-settings";

/**
 * A page's "Restore defaults": the button for its header, and the strip under the header that names
 * what it resets before it does. Disabled, and saying so, while nothing differs.
 */
export function useRestoreDefaults(defaults: readonly DefaultSetting[] | undefined) {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (defaults === undefined) return { button: null, strip: null };
  const changed = settings === undefined ? [] : changedSettings(defaults, settings);
  const reason =
    settings === undefined
      ? "Loading settings…"
      : changed.length === 0
        ? "Everything here is already at its default."
        : undefined;

  const restore = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await save(restorePatch(changed));
    } catch (e) {
      setError(`Couldn't restore the defaults: ${errorMessage(e)}`);
      return;
    } finally {
      setBusy(false);
    }
    setConfirming(false);
    for (const setting of changed) setting.afterRestore?.();
    if (!changed.some((setting) => setting.refreshesReviewRequests === true)) return;
    // The defaults are saved by now; only the list behind them is late.
    try {
      await api.refreshReviewRequests({ force: true });
      await queryClient.invalidateQueries({ queryKey: ["reviewRequests"] });
    } catch (e) {
      setError(`Defaults restored, but the review requests didn't refresh: ${errorMessage(e)}`);
    }
  };

  const button = (
    <WhyDisabled reason={reason}>
      <Button
        size="sm"
        variant="ghost"
        disabled={reason !== undefined}
        aria-expanded={confirming}
        onClick={() => setConfirming((open) => !open)}
      >
        <Undo2 data-icon="inline-start" />
        Restore defaults
      </Button>
    </WhyDisabled>
  );
  const strip = (
    <>
      {confirming && changed.length > 0 && (
        <ConfirmStrip
          label="Restore defaults"
          message={`Resets ${listLabels(changed.map((setting) => setting.label))}.`}
          confirm="Restore defaults"
          busy={busy}
          onConfirm={() => void restore()}
          onKeep={() => setConfirming(false)}
        />
      )}
      {error && <ExpandableError message={error} />}
    </>
  );
  return { button, strip };
}
