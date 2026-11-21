// Letting an agent's page go when its pane closes. The page's debugger session stays attached: the
// WebRTC guard holds the same one (`preview/webrtc-guard.ts`), and detaching would take its removal
// away. What the pane's driver set on the page is undone instead.

/** Sends one protocol command on the page's own session. */
type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** The domains the driver turned on (`core/page-driver.ts`), but the page's, which the guard needs. */
const DRIVER_DOMAINS = ["Runtime", "Accessibility", "DOM", "Network"] as const;

/** Undoes the driver's emulation and domains; `userAgent` is the page's own, to put back. */
export async function releasePage(send: Send, userAgent: string | undefined): Promise<void> {
  const quietly = (method: string, params: Record<string, unknown> = {}) =>
    send(method, params).catch(() => {});
  await Promise.all([
    quietly("Emulation.clearDeviceMetricsOverride"),
    quietly("Emulation.setTouchEmulationEnabled", { enabled: false }),
    quietly("Emulation.setEmulatedMedia", { features: [] }),
    quietly("Emulation.setFocusEmulationEnabled", { enabled: false }),
    ...(userAgent === undefined ? [] : [quietly("Emulation.setUserAgentOverride", { userAgent })]),
    ...DRIVER_DOMAINS.map((domain) => quietly(`${domain}.disable`)),
  ]);
}
