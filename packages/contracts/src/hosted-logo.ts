/** The image types a hosted server's mark may be (`HostedDiscovery.logo_uri`). */
export const HOSTED_LOGO_TYPES = ["image/svg+xml", "image/png", "image/webp", "image/jpeg"] as const;
export type HostedLogoType = (typeof HOSTED_LOGO_TYPES)[number];

/** The most bytes a server's mark may be: a small mark, not a picture. */
export const HOSTED_LOGO_MOST = 16 * 1024;

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0): boolean =>
  prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): ReadonlyArray<number> => [...text].map((char) => char.charCodeAt(0));

/**
 * What image `bytes` are by their own first bytes, whatever they were labelled: PNG, JPEG and WebP
 * by their signatures, SVG as UTF-8 text whose first element is `<svg`. Undefined for anything else.
 */
export const sniffHostedLogo = (bytes: Uint8Array): HostedLogoType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const body = text
    .replace(/^\uFEFF/, "")
    .replace(/^\s*<\?xml[^>]*\?>/, "")
    .replace(/^(\s*<!--[\s\S]*?-->)*/, "")
    .replace(/^\s*<!DOCTYPE svg[^>]*>/i, "")
    .replace(/^(\s*<!--[\s\S]*?-->)*/, "")
    .trimStart();
  return /^<svg[\s>/]/.test(body) ? "image/svg+xml" : undefined;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return undefined;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/**
 * A server's mark as Gram keeps and shows it, from its bytes and the type it came labelled with:
 * `data:<type>;base64,…`. Undefined unless the bytes are that image type by their own first bytes,
 * and no more than `HOSTED_LOGO_MOST`.
 */
export const hostedLogoOf = (bytes: Uint8Array, labelled: string): string | undefined => {
  const type = labelled.split(";")[0]?.trim().toLowerCase();
  if (bytes.length === 0 || bytes.length > HOSTED_LOGO_MOST) return undefined;
  if (type === undefined || sniffHostedLogo(bytes) !== type) return undefined;
  return `data:${type};base64,${toBase64(bytes)}`;
};

/**
 * A `data:` image a server named as its mark, as Gram keeps it (`hostedLogoOf`), base64 or
 * percent-encoded as it came. Undefined for any other address, or one that isn't that image.
 */
export const hostedLogoFromData = (address: string): string | undefined => {
  const match = /^data:([a-z0-9.+/-]+)((?:;[a-z0-9-]+=[a-z0-9.-]+)*)(;base64)?,(.*)$/is.exec(address);
  if (match === null) return undefined;
  const [, type = "", , base64, payload = ""] = match;
  if (payload.length > HOSTED_LOGO_MOST * 3) return undefined;
  let bytes: Uint8Array | undefined;
  if (base64 === undefined)
    try {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
      return undefined;
    }
  else bytes = fromBase64(payload);
  return bytes === undefined ? undefined : hostedLogoOf(bytes, type);
};

/** Whether `logo` is a mark as Gram keeps one (`hostedLogoOf`): what a machine's record may hold. */
export const isHostedLogo = (logo: unknown): logo is string =>
  typeof logo === "string" && logo.startsWith("data:image/") && hostedLogoFromData(logo) === logo;
