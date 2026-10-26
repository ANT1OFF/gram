// Observations from Gram's attached page driver, never a claim about an agent/provider's tools.
export interface BrowserInspectionCapabilities {
  readonly version: 1;
  readonly screenshotMetadata: true;
  readonly targetGeometry: "top-frame-css";
  readonly viewportPresets: true;
  readonly diagnostics: "bounded-redacted";
  readonly explicitTakeOver: true;
}
export const BROWSER_INSPECTION_CAPABILITIES: BrowserInspectionCapabilities = {
  version: 1,
  screenshotMetadata: true,
  targetGeometry: "top-frame-css",
  viewportPresets: true,
  diagnostics: "bounded-redacted",
  explicitTakeOver: true,
};
export const BROWSER_VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
} as const;
export type BrowserViewportPreset = "pane" | keyof typeof BROWSER_VIEWPORTS;
/** Custom viewport bounds, in CSS pixels. */
export const BROWSER_VIEWPORT_MIN = 200;
export const BROWSER_VIEWPORT_MAX = 4096;
/** Mobile emulation (touch, a phone's user agent) is offered only below this width. */
export const BROWSER_MOBILE_MAX_WIDTH = 768;
export type BrowserColorScheme = "light" | "dark";
/** What the driver emulates now, beyond the pane's own size. */
export interface BrowserEmulation {
  /** Absent at the pane's natural size. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** Touch points and a phone's user agent; only below `BROWSER_MOBILE_MAX_WIDTH`. */
  readonly mobile: boolean;
  /** Absent follows the system's scheme. */
  readonly colorScheme?: BrowserColorScheme | undefined;
}
export interface BrowserRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly scale: number;
}
export interface BrowserTarget {
  readonly source: "dom-ref" | "coordinate" | "region";
  readonly ref?: string | undefined;
  /** Top-frame viewport CSS coordinates. No inferred iframe-local mapping. */
  readonly point?: readonly [number, number] | undefined;
  readonly region?: BrowserRegion | undefined;
  /** A drag's destination, as a ref and the point it was measured at. */
  readonly toRef?: string | undefined;
  readonly toPoint?: readonly [number, number] | undefined;
}
export interface BrowserCapture {
  readonly id: string;
  readonly source: "cdp-page";
  readonly documentId: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly viewport: BrowserViewport;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Observed before capture. Page layout may change between these observations. */
  readonly target?: BrowserTarget | undefined;
  readonly targetObservedAt?: number | undefined;
}
export interface BrowserAction {
  readonly id: string;
  readonly op:
    | "evaluate"
    | "click"
    | "type"
    | "formInput"
    | "pressKey"
    | "hover"
    | "scroll"
    | "scrollTo"
    | "drag";
  readonly documentId: string;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  /** A dispatch acknowledgement is not proof of the page's application effect. */
  readonly status: "not-dispatched" | "dispatch-completed" | "dispatch-unknown";
  readonly dispatchStartedAt?: number | undefined;
  readonly target?: BrowserTarget | undefined;
  readonly viewport?: BrowserViewport | undefined;
  /** Fixed driver error category; no page-derived exception or input value. */
  readonly failure?: "target-unavailable" | "dispatch-error" | "user-control" | undefined;
}
export interface BrowserNetworkFailure {
  /** Origin only: paths/query/fragment may contain arbitrary secrets and are omitted. */
  readonly url: string;
  readonly kind: "http" | "transport";
  readonly status?: number | undefined;
  readonly at: number;
  readonly durationMs?: number | undefined;
}
export interface BrowserDiagnostics {
  readonly since: number;
  readonly observedAt: number;
  readonly console: readonly {
    readonly level: string;
    readonly text: string;
    readonly at: number;
  }[];
  readonly network: readonly BrowserNetworkFailure[];
  readonly droppedConsole: number;
  readonly droppedNetwork: number;
  readonly contentPolicy: "console-content-and-url-paths-omitted";
}
export interface BrowserInspection {
  readonly capabilities: BrowserInspectionCapabilities;
  /** Current driver document identity; absent on older observation records. */
  readonly documentId?: string | undefined;
  readonly capture?: BrowserCapture | undefined;
  readonly action?: BrowserAction | undefined;
  readonly diagnostics?: BrowserDiagnostics | undefined;
  /** Absent for a custom size. */
  readonly viewportPreset?: BrowserViewportPreset | undefined;
  readonly emulation?: BrowserEmulation | undefined;
}
