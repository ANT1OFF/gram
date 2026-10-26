import { useNavigate } from "@tanstack/react-router";
import { ArrowDownToLine, RotateCw, TriangleAlert } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion/spinner";
import { useFeature } from "@/settings/use-diagnostics";
import { useServerSettings } from "@/settings-sync/store";

import { nativeUpdates } from "./native";
import { useUpdateStore } from "./store";
import { pillView, type PillView } from "./update-pill-view";

const RING = 2 * Math.PI * 6;

/** A small ring that fills as the download does; it moves only with motion on. */
function ProgressRing({ percent }: { percent: number }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 -rotate-90">
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={RING}
        strokeDashoffset={RING * (1 - Math.min(100, Math.max(0, percent)) / 100)}
        className="stroke-primary motion-safe:transition-[stroke-dashoffset] motion-safe:duration-150"
      />
    </svg>
  );
}

function PillIcon({ view }: { view: PillView }) {
  switch (view.kind) {
    case "checking":
    case "installing":
      return <Spinner aria-hidden />;
    case "available":
      return (
        <span className="relative grid place-items-center">
          <ArrowDownToLine aria-hidden />
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
          />
        </span>
      );
    case "downloading":
      return <ProgressRing percent={view.percent ?? 0} />;
    case "ready":
      return <RotateCw aria-hidden />;
    case "error":
    case "notApplied":
      return <TriangleAlert aria-hidden />;
  }
}

function PillHint({ view }: { view: PillView }) {
  return (
    <span className="flex max-w-72 flex-col gap-1.5">
      <span>{view.hint}</span>
      {view.notes && (
        <span
          data-testid="update-pill-notes"
          className="line-clamp-6 border-t border-current/20 pt-1.5 opacity-75"
        >
          {view.notes}
        </span>
      )}
    </span>
  );
}

const ACCESSIBLE: Record<PillView["kind"], (view: PillView) => string> = {
  checking: () => "Checking for updates",
  available: (view) => `Download Gram ${view.version}`,
  downloading: (view) => `Downloading Gram ${view.version}, ${view.percent}%`,
  ready: (view) => `Restart to update to Gram ${view.version}`,
  installing: (view) => `Restarting into Gram ${view.version}`,
  error: () => "Update problem",
  notApplied: (view) => `Gram ${view.version} wasn't applied`,
};

/**
 * A signed install's update, as one control beside Usage and Settings: hidden while there's
 * nothing to say, then checking, available (click to download), downloading with its percent,
 * ready (click to restart into it), or a problem with its reason on hover. Settings → Updates
 * shows the same state.
 */
export function UpdatePill({ size = "sm" }: { size?: "xs" | "sm" }) {
  const shown = useFeature("appUpdates", { settled: true });
  const state = useUpdateStore((s) => s.native);
  // A retried check asks for the saved channel, which a refusal may have found changed.
  const savedChannel = useServerSettings((s) => s.settings?.updates.channel);
  const navigate = useNavigate();
  const view = pillView(state);
  if (!shown || !state || !view) return null;

  const run = () => {
    switch (view.action) {
      case "download":
        return void nativeUpdates.download();
      case "install":
        return view.version === undefined ? undefined : void nativeUpdates.install(view.version);
      case "check":
        return void nativeUpdates.check(savedChannel ?? state.channel);
      case "settings":
        return void navigate({ to: "/settings/updates" });
      case "none":
        return undefined;
    }
  };
  const labelled = view.label !== undefined;
  return (
    <Hint
      label={<PillHint view={view} />}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size={labelled ? (size === "xs" ? "xs" : "sm") : size === "xs" ? "icon-xs" : "icon-sm"}
          aria-label={ACCESSIBLE[view.kind](view)}
          aria-disabled={view.action === "none" || undefined}
          data-testid="update-pill"
          data-kind={view.kind}
          className={cn(
            "relative text-muted-foreground [-webkit-app-region:no-drag]",
            labelled && "px-1.5 tabular-nums",
            view.kind === "ready" && "text-primary hover:text-primary",
            (view.kind === "error" || view.kind === "notApplied") &&
              "text-warning hover:text-warning",
            view.action === "none" && "cursor-default hover:bg-transparent",
          )}
          onClick={run}
        />
      }
    >
      <PillIcon view={view} />
      {labelled && <span>{view.label}</span>}
    </Hint>
  );
}
