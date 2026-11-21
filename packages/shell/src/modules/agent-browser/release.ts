type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

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
