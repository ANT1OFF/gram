import {
  HOSTED_LOGO_MOST,
  HOSTED_LOGO_TYPES,
  type HostedDiscovery,
  hostedLogoFromData,
  hostedLogoOf,
} from "@gram/contracts";
import type { Fetch } from "./hosted.ts";

/** How long a fetch of a server's mark may take before the app goes without it. */
export const HOSTED_LOGO_TIMEOUT_MS = 5000;

/** How long a mark that couldn't be had is gone without before it is fetched again. */
export const HOSTED_LOGO_RETRY_MS = 10 * 60_000;

const bodyOf = async (response: Response): Promise<Uint8Array | undefined> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > HOSTED_LOGO_MOST || response.body === null) return undefined;
  const reader = response.body.getReader();
  const parts: Array<Uint8Array> = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > HOSTED_LOGO_MOST) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      parts.push(value);
    }
  } catch {
    return undefined;
  }
  return new Uint8Array(Buffer.concat(parts));
};

/**
 * The mark `discovery` names, as Gram keeps one (`hostedLogoOf`), or undefined when it names none or
 * none the app could read: not on the server's origin (`checkHostedDiscovery` keeps only those),
 * redirected, not answered 200, or not an image of a type Gram shows.
 */
export const fetchHostedLogo = async (
  discovery: Pick<HostedDiscovery, "logo_uri">,
  fetch: Fetch,
): Promise<string | undefined> => {
  const address = discovery.logo_uri;
  if (address === undefined) return undefined;
  if (address.startsWith("data:")) return hostedLogoFromData(address);
  try {
    const response = await fetch(address, {
      method: "GET",
      headers: { accept: HOSTED_LOGO_TYPES.join(", ") },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(HOSTED_LOGO_TIMEOUT_MS),
    });
    if (response.status !== 200) return undefined;
    const type = response.headers.get("content-type") ?? "";
    const bytes = await bodyOf(response);
    return bytes === undefined ? undefined : hostedLogoOf(bytes, type);
  } catch {
    return undefined;
  }
};

/**
 * Each server's mark, fetched once for each address it names and kept for the app's run; one that
 * couldn't be had is fetched again after `HOSTED_LOGO_RETRY_MS`.
 */
export const hostedLogos = (now: () => number = Date.now) => {
  const kept = new Map<
    string,
    { readonly logo: Promise<string | undefined>; failedAt?: number | undefined }
  >();
  return (
    origin: string,
    discovery: Pick<HostedDiscovery, "logo_uri">,
    fetch: Fetch,
  ): Promise<string | undefined> => {
    if (discovery.logo_uri === undefined) return Promise.resolve(undefined);
    const key = `${origin} ${discovery.logo_uri}`;
    const held = kept.get(key);
    if (held !== undefined && (held.failedAt === undefined || now() - held.failedAt < HOSTED_LOGO_RETRY_MS))
      return held.logo;
    const entry: { logo: Promise<string | undefined>; failedAt?: number } = {
      logo: fetchHostedLogo(discovery, fetch).then((logo) => {
        if (logo === undefined) entry.failedAt = now();
        return logo;
      }),
    };
    kept.set(key, entry);
    return entry.logo;
  };
};
