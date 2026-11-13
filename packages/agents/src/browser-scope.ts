// The sites a session opened with the user's browser is limited to
// (`OpenSessionOptions.browserScope`): which host an address is on, and whether a call opens one
// outside the list. Pure, so both adapters and their tests read the same rule.

/** The host an address is on, in lower case, with its port when it names one; none if it has none. */
export const siteOf = (address: string): string | undefined => {
  const trimmed = address.trim();
  if (trimmed === "") return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.host === "" ? undefined : url.host.toLowerCase();
  } catch {
    return undefined;
  }
};

/** Whether `address` is on one of `sites`, each a host matched exactly. */
export const onListedSite = (address: string, sites: ReadonlyArray<string>): boolean => {
  const site = siteOf(address);
  return site !== undefined && sites.includes(site);
};

/**
 * The address a tool call opens that is on none of `sites`, if it opens one: any call whose
 * input carries a `url`. Moving through a tab's history (`back`, `forward`) opens nothing new.
 * A click that follows a link is not seen here.
 */
export const offSiteAddress = (
  toolInput: unknown,
  sites: ReadonlyArray<string>,
): string | undefined => {
  if (typeof toolInput !== "object" || toolInput === null || !("url" in toolInput))
    return undefined;
  const { url } = toolInput;
  if (typeof url !== "string" || url === "back" || url === "forward") return undefined;
  return onListedSite(url, sites) ? undefined : url;
};
