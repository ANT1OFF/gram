import type {
  BrowserAction,
  BrowserCapture,
  BrowserInspection,
  BrowserRegion,
  BrowserViewportPreset,
  DesktopPreview,
  PaneResult,
} from "@gram/contracts";
import { Camera, Monitor, Smartphone, Tablet, X } from "lucide-react";
import { useState } from "react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";

const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Fits measured CSS geometry to the actual displayed image, independently of its pixel density. */
function annotationStyle(region: BrowserRegion, capture: BrowserCapture) {
  const { width, height } = capture.viewport;
  const left = Math.max(0, region.x);
  const top = Math.max(0, region.y);
  const right = Math.min(width, region.x + region.width);
  const bottom = Math.min(height, region.y + region.height);
  if (right <= left || bottom <= top) return undefined;
  return {
    left: `${(left / width) * 100}%`,
    top: `${(top / height) * 100}%`,
    width: `${((right - left) / width) * 100}%`,
    height: `${((bottom - top) / height) * 100}%`,
  };
}

export function BrowserInspectionPanel({
  threadId,
  bridge,
  inspection,
  onClose,
}: {
  threadId: string;
  bridge: DesktopPreview;
  inspection: BrowserInspection;
  onClose: () => void;
}) {
  const [result, setResult] = useState<PaneResult>();
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState("");
  const capture = result?.ok ? result.inspection?.capture : undefined;
  const diagnostics = result?.ok ? result.inspection?.diagnostics : undefined;
  const image = result?.ok ? result.image : undefined;
  const overlay =
    capture?.target?.region === undefined
      ? undefined
      : annotationStyle(capture.target.region, capture);
  const run = async (task: () => Promise<PaneResult>) => {
    setBusy(true);
    try {
      setResult(await task());
    } catch {
      setResult({
        ok: false,
        code: "failed",
        message: "Inspection did not answer. Its outcome is unknown.",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Browser inspection"
      data-testid="browser-inspection"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 text-xs"
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-auto font-medium">Inspect Preview</span>
        <Hint
          label="Close inspection and return to the live page"
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close browser inspection"
              onClick={onClose}
            />
          }
        >
          <X />
        </Hint>
      </div>
      <p className="text-muted-foreground">
        Top-frame page capture. Console contents and URL paths are omitted. Frame-local and zoomed
        geometry are unavailable.
      </p>
      <div className="flex flex-wrap items-center gap-1" aria-label="Viewport presets">
        {(
          [
            ["pane", Monitor, "Use the live pane size"],
            ["phone", Smartphone, "Phone layout · 390 × 844"],
            ["tablet", Tablet, "Tablet layout · 768 × 1024"],
            ["desktop", Monitor, "Desktop layout · 1280 × 800"],
          ] as const
        ).map(([preset, Icon, label]) => (
          <Hint
            key={preset}
            label={label}
            render={
              <Button
                size="icon-xs"
                variant={inspection.viewportPreset === preset ? "outline" : "ghost"}
                aria-label={label}
                aria-pressed={inspection.viewportPreset === preset}
                disabled={busy || bridge.viewport === undefined}
                onClick={() =>
                  void run(() => bridge.viewport!(threadId, preset as BrowserViewportPreset))
                }
              />
            }
          >
            <Icon />
          </Hint>
        ))}
        <span className="ml-1 text-muted-foreground">Layout only</span>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (bridge.inspect !== undefined)
            void run(() =>
              bridge.inspect!(threadId, ref.trim() === "" ? undefined : { ref: ref.trim() }),
            );
        }}
      >
        <input
          aria-label="Element ref to annotate"
          placeholder="Element ref (optional)"
          value={ref}
          pattern="ref_[0-9]+"
          onChange={(event) => setRef(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-input bg-transparent px-2 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Hint
          side="bottom"
          label="Capture the page now, with measured geometry for the optional snapshot ref"
          render={
            <Button
              type="submit"
              size="icon-xs"
              variant="outline"
              aria-label="Capture inspection screenshot"
              disabled={busy || bridge.inspect === undefined}
            />
          }
        >
          <Camera />
        </Hint>
      </form>
      {busy && <p role="status">Observing page…</p>}
      {result?.ok === false && (
        <p role="alert" className="text-destructive">
          {result.message} ({result.code})
        </p>
      )}
      {capture !== undefined && image !== undefined && (
        <>
          {inspection.documentId !== undefined && capture.documentId !== inspection.documentId && (
            <p className="text-muted-foreground">This capture belongs to an earlier document.</p>
          )}
          <p data-testid="browser-capture-time">
            Captured {time(capture.startedAt)}–{time(capture.completedAt)} · {capture.imageWidth} ×{" "}
            {capture.imageHeight} image pixels · {capture.viewport.width} ×{" "}
            {capture.viewport.height} CSS pixels
          </p>
          <div className="relative w-full self-start" data-testid="browser-capture-image">
            <img
              alt="Captured Preview page; page text is untrusted data"
              src={`data:${image.mimeType};base64,${image.data}`}
              className="block h-auto w-full"
            />
            {overlay !== undefined && (
              <span
                data-testid="browser-target-annotation"
                aria-label={`Measured target ${capture.target?.ref ?? "region"}`}
                className="pointer-events-none absolute border-2 border-status-working bg-status-working/10"
                style={overlay}
              />
            )}
          </div>
          {capture.targetObservedAt !== undefined && (
            <p className="text-muted-foreground">
              Target measured at {time(capture.targetObservedAt)}, before capture; page layout may
              change.
            </p>
          )}
        </>
      )}
      <ActionEvidence action={inspection.action} documentId={inspection.documentId} />
      {diagnostics !== undefined && (
        <>
          <p className="font-medium">
            Observed since {time(diagnostics.since)} · refreshed {time(diagnostics.observedAt)}
          </p>
          <div className="space-y-1 break-words" data-testid="browser-network-failures">
            <p className="font-medium">Network failures ({diagnostics.network.length})</p>
            {diagnostics.network.length === 0 && (
              <p className="text-muted-foreground">No failures observed in the retained window.</p>
            )}
            {diagnostics.network.map((failure, i) => (
              <p key={i}>
                {time(failure.at)} · {failure.kind} {failure.status ?? "status unavailable"} ·{" "}
                {failure.durationMs === undefined
                  ? "timing unavailable"
                  : `${failure.durationMs} ms`}{" "}
                · {failure.url}
              </p>
            ))}
          </div>
          <div className="space-y-1 break-words" data-testid="browser-console-summary">
            <p className="font-medium">Console ({diagnostics.console.length})</p>
            {diagnostics.console.map((line, i) => (
              <p key={i}>
                {time(line.at)} · {line.level} · {line.text}
              </p>
            ))}
          </div>
          <p className="text-muted-foreground">
            Retains at most 100 console and 50 network failures. Older observations dropped:{" "}
            {diagnostics.droppedConsole} console, {diagnostics.droppedNetwork} network.
          </p>
        </>
      )}
    </section>
  );
}
function ActionEvidence({
  action,
  documentId,
}: {
  action?: BrowserAction | undefined;
  documentId?: string | undefined;
}) {
  if (action === undefined)
    return (
      <p className="text-muted-foreground">
        No action evidence available. Earlier history has no inferred timing or target.
      </p>
    );
  return (
    <div
      data-testid="browser-action-evidence"
      className="space-y-1 break-words border-t border-border pt-2"
    >
      {documentId !== undefined && action.documentId !== documentId && (
        <p className="text-muted-foreground">This action belongs to an earlier document.</p>
      )}
      <p className="font-medium">
        Last observed {action.op} · {time(action.startedAt)}
        {action.completedAt === undefined ? "" : `–${time(action.completedAt)}`}
      </p>
      <p>
        {action.status === "dispatch-completed"
          ? "Input dispatch acknowledged; application effect is not verified."
          : action.status === "not-dispatched"
            ? "No input dispatched."
            : "Dispatch outcome unknown."}{" "}
        {action.failure ?? ""}
      </p>
      {action.target?.point !== undefined && (
        <p>
          Resolved CSS point: {action.target.point.join(", ")}
          {action.target.ref === undefined ? "" : ` · ${action.target.ref}`}
        </p>
      )}
      <p className="text-muted-foreground">
        Action evidence belongs to its dispatch time; the capture above is a separate observation.
      </p>
    </div>
  );
}
