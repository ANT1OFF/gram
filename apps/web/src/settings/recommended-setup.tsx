import { Dialog } from "@base-ui/react/dialog";
import { RECOMMENDED, type SettingsPatch } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { useServerSettings } from "@/settings-sync/store";

import { SettingRow } from "./fields";
import { useAvailableModels } from "./model-slots";
import {
  recommendedSummary,
  tierRows,
  turnOffKeepWrites,
  turnOnRows,
  turnOnWrites,
  type TurnOnWrites,
} from "./recommended-setup-model";
import { useSaveSettings } from "./use-save-settings";

// The Recommended setup row of Settings → Agents & models, its Details fold, and the two sheets it
// opens: the one-time turn-on sheet and the turn-off question (mock: recommended-setup v1).

const OFF_TEXT =
  "Gram picks a model for each kind of work and keeps it current with each release. Models you choose stay yours.";

const SHEET_CLASS =
  "fixed top-1/2 left-1/2 z-50 flex max-h-[min(40rem,calc(100vh-2rem))] w-[min(35rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-edge bg-popover p-5 text-popover-foreground shadow-overlay outline-none transition-[scale,opacity] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const BACKDROP_CLASS =
  "fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";

/** Writes a sheet's settings patch and each workspace charter it changes. */
function useApply() {
  const api = useApi();
  const save = useSaveSettings();
  const queryClient = useQueryClient();
  return async (writes: TurnOnWrites) => {
    for (const { id, charter } of writes.charters) await api.setOrchestratorCharter(id, charter);
    await save(writes.patch);
    if (writes.charters.length > 0)
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  };
}

/** Each tier as it stands on this machine, folded under the row. */
function TierDetails() {
  const available = useAvailableModels();
  const rows = tierRows(available);
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden className="size-icon-row group-data-[panel-open]:hidden" />
        <ChevronDown aria-hidden className="hidden size-icon-row group-data-[panel-open]:block" />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div data-testid="recommended-tiers" className="flex flex-col gap-1 pt-2">
          <table className="w-full text-meta">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Tier</th>
                <th className="py-1 pr-3 font-medium">On this machine</th>
                <th className="py-1 font-medium">For</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tier} className="border-t border-edge align-top">
                  <td className="py-1.5 pr-3">{row.name}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {row.runsOn ?? <span className="text-muted-foreground">Not here</span>}
                  </td>
                  <td className="py-1.5 text-muted-foreground">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="text-meta text-muted-foreground">
            {`Recommendations ${RECOMMENDED.version}. Effort never goes past High.`}
          </span>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The one-time sheet for an install turning the mode on: every slot, past defaults pre-ticked. */
function TurnOnSheet({ onClose }: { onClose: () => void }) {
  const settings = useServerSettings((s) => s.settings)!;
  const { workspaces, settled } = useWorkspacesQuery();
  const available = useAvailableModels();
  const rows = turnOnRows(settings, workspaces, available);
  // Only what the user changed is kept: rows arrive as the workspaces and models load, and each
  // starts at its own default (ticked for a past Gram default).
  const [changed, setChanged] = useState<ReadonlyMap<string, boolean>>(new Map());
  const ticked: ReadonlySet<string> = new Set(
    rows
      .filter((row) => row.canFollow && (changed.get(row.key) ?? row.ticked))
      .map((row) => row.key),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const apply = useApply();
  const titleId = useId();
  const confirm = () => {
    setBusy(true);
    setError(undefined);
    apply(turnOnWrites(settings, workspaces, available, ticked))
      .then(onClose)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP_CLASS} />
        <Dialog.Popup
          data-testid="recommended-turn-on"
          data-surface="overlay"
          aria-labelledby={titleId}
          className={SHEET_CLASS}
        >
          <div className="flex flex-col gap-1">
            <Dialog.Title id={titleId} className="text-title font-semibold">
              Follow the recommended setup?
            </Dialog.Title>
            <Dialog.Description className="text-meta text-muted-foreground">
              Ticked models follow Gram&apos;s recommendation from now on and change with its
              releases. Unticked ones stay exactly as you set them.
            </Dialog.Description>
          </div>
          <ul className="flex flex-col rounded-md border border-edge">
            {rows.map((row) => (
              <li key={row.key} className="border-edge not-first:border-t">
                <label
                  data-testid="recommended-turn-on-row"
                  data-key={row.key}
                  className="flex items-start gap-2.5 px-3 py-2.5"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-primary"
                    checked={ticked.has(row.key)}
                    disabled={!row.canFollow || busy}
                    onChange={(event) =>
                      setChanged((current) => new Map(current).set(row.key, event.target.checked))
                    }
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{row.label}</span>
                    <span className="text-meta break-words text-muted-foreground">
                      {row.change}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <span className="text-meta text-muted-foreground">
            Ticked: Gram&apos;s own past defaults. Unticked: values you picked.
          </span>
          {error !== undefined && (
            <p role="alert" className="text-meta text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              data-testid="recommended-turn-on-confirm"
              disabled={busy || !settled || !available.settled}
              onClick={confirm}
            >
              Follow recommended
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Turning the mode off asks once: keep the current models as the user's own, or keep following. */
function TurnOffSheet({ onClose }: { onClose: () => void }) {
  const settings = useServerSettings((s) => s.settings)!;
  const { workspaces } = useWorkspacesQuery();
  const available = useAvailableModels();
  const apply = useApply();
  const save = useSaveSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const run = (work: Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    work
      .then(onClose)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const seen = settings.agents.recommendedSetup?.seen;
  const off: SettingsPatch = {
    agents: { recommendedSetup: { enabled: false, ...(seen === undefined ? {} : { seen }) } },
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP_CLASS} />
        <Dialog.Popup
          data-testid="recommended-turn-off"
          data-surface="overlay"
          aria-labelledby={titleId}
          className={SHEET_CLASS}
        >
          <div className="flex flex-col gap-1">
            <Dialog.Title id={titleId} className="text-title font-semibold">
              Turn off the recommended setup?
            </Dialog.Title>
            <Dialog.Description className="text-meta text-muted-foreground">
              Keep the models that follow it as your own, on what they run today, or leave them
              following.
            </Dialog.Description>
          </div>
          {error !== undefined && (
            <p role="alert" className="text-meta text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => run(save(off))}>
              Keep following
            </Button>
            <Button
              data-testid="recommended-turn-off-keep"
              disabled={busy}
              onClick={() => run(apply(turnOffKeepWrites(settings, workspaces, available)))}
            >
              Keep current models
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The Recommended setup row: its switch, this machine's summary while on, and the Details fold.
 * Turning it on opens the one-time sheet until it has been confirmed once; turning it off asks.
 */
export function RecommendedSetupRow() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [sheet, setSheet] = useState<"on" | "off">();
  // Lists the harnesses only for the summary while on: an off row probes nothing.
  const available = useAvailableModels(settings?.agents.recommendedSetup?.enabled === true);
  const [error, setError] = useState<string>();
  const id = useId();
  if (settings === undefined) return null;
  const mode = settings.agents.recommendedSetup;
  const on = mode?.enabled === true;
  const summary = recommendedSummary(available);
  const turn = (next: boolean) => {
    setError(undefined);
    if (!next) {
      setSheet("off");
      return;
    }
    if (mode?.seen === undefined) {
      setSheet("on");
      return;
    }
    save({ agents: { recommendedSetup: { enabled: true, seen: mode.seen } } }).catch((e: unknown) =>
      setError(errorMessage(e)),
    );
  };
  return (
    <>
      <SettingRow
        label="Recommended setup"
        htmlFor={id}
        description={on && summary !== undefined ? summary : OFF_TEXT}
        keywords={["recommended", "tier", "lead", "scoped", "cheap", "top", "model"]}
        error={error}
        detail={on ? <TierDetails /> : undefined}
      >
        <Switch
          id={id}
          data-testid="recommended-setup-switch"
          checked={on}
          onCheckedChange={(next) => turn(next)}
        />
      </SettingRow>
      {sheet === "on" && <TurnOnSheet onClose={() => setSheet(undefined)} />}
      {sheet === "off" && <TurnOffSheet onClose={() => setSheet(undefined)} />}
    </>
  );
}
