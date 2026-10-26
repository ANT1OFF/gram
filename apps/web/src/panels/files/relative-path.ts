const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves a markdown link or image `href` found in `filePath` to a path inside `root`. Returns
 * `undefined` for external URLs (`https:`, `mailto:`, `data:`…), in-page anchors, protocol-relative
 * links, and anything that escapes the checkout. Query strings and fragments are dropped.
 */
export function resolveInCheckout(
  href: string,
  filePath: string,
  root: string,
): string | undefined {
  const trimmed = href.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    SCHEME.test(trimmed)
  ) {
    return undefined;
  }
  let target: string;
  try {
    target = decodeURIComponent(trimmed.split(/[?#]/)[0] ?? "");
  } catch {
    return undefined;
  }
  if (target === "") return undefined;
  const base = target.startsWith("/") ? root : filePath.slice(0, filePath.lastIndexOf("/"));
  const segments: string[] = [];
  for (const segment of `${base}/${target}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  return resolved === root || resolved.startsWith(`${root}/`) ? resolved : undefined;
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);

export const isImagePath = (path: string) =>
  IMAGE_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

export const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
