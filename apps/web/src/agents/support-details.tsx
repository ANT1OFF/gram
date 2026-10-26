import type {
  FeatureSupport,
  HarnessFeature,
  SelectedHarnessSupport,
} from "@gram/contracts/agent-support";
import type { ThreadId } from "@gram/contracts";

import { Button } from "@/components/ui/button";

import { usePreviewInspectionSupport } from "./browser-inspection-support";

const OPTIONAL_FEATURES: ReadonlyArray<readonly [HarnessFeature, string]> = [
  ["browser", "Preview browser tools"],
  ["compaction", "Manual compaction"],
  ["imageInput", "Image input"],
  ["dream", "Dream"],
  ["dreamFiles", "Dream with enforced file-only access"],
  ["dreamGuided", "Dream with normal permissions"],
];

/** Optional capabilities describe only their own evidence and never disable ordinary sessions. */
export function HarnessSupportDetails({
  observation,
  imageInput,
  threadId,
}: {
  readonly observation: SelectedHarnessSupport | undefined;
  readonly imageInput?: FeatureSupport | undefined;
  readonly threadId?: ThreadId | undefined;
}) {
  const preview = usePreviewInspectionSupport(
    threadId,
    window.gram?.preview ?? window.gramMock?.shell.preview,
  );
  if (observation === undefined) return null;
  return (
    <details className="text-xs text-muted-foreground" data-testid="harness-support-details">
      <summary className="cursor-pointer">
        Harness capabilities
        {observation.version === undefined ? "" : ` · CLI ${observation.version}`}
      </summary>
      <dl className="mt-2 grid gap-2">
        {OPTIONAL_FEATURES.map(([feature, label]) => {
          const support =
            feature === "imageInput"
              ? (imageInput ?? observation.support[feature])
              : observation.support[feature];
          return (
            <div key={feature}>
              <dt className="font-medium">
                {label} ·{" "}
                {support?.state === "supported"
                  ? "Verified"
                  : support?.state === "unsupported"
                    ? "Unsupported"
                    : "Unverified"}
              </dt>
              <dd>
                {support?.state === "supported"
                  ? support.evidence
                  : (support?.reason ?? "This harness has not reported support for this feature.")}
              </dd>
            </div>
          );
        })}
        <div data-testid="preview-inspection-support">
          <dt className="font-medium">
            Attached preview inspection ·{" "}
            {preview.support.state === "available"
              ? "Available"
              : preview.support.state === "unavailable"
                ? "Unavailable"
                : preview.support.state === "unknown"
                  ? "Unverified"
                  : "Checking"}
          </dt>
          <dd>
            {preview.support.state === "available" ? (
              <>
                Screenshot metadata; top-frame CSS target geometry; viewport presets; bounded,
                redacted diagnostics; explicit Take over. This is attached shell support; agent
                browser tool support is shown separately above.
              </>
            ) : (
              <>
                {preview.support.reason}
                {threadId !== undefined && preview.support.state !== "checking" && (
                  <Button type="button" size="xs" variant="ghost" onClick={preview.retry}>
                    Retry preview check
                  </Button>
                )}
              </>
            )}
          </dd>
        </div>
      </dl>
    </details>
  );
}
