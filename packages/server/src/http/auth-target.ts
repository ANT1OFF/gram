import { FindMyWay } from "../platform/unstable.ts";

/** All paths with authentication/credential semantics, including the root boot exchange. */
const protectedPaths = [
  "/",
  "/ws",
  "/mcp",
  "/remote/pair",
  "/remote/connect",
  "/remote/claim",
] as const;
const protectedRoutes = FindMyWay.make<string>();
for (const path of protectedPaths) protectedRoutes.all(path, path);

/**
 * Parse origin-form targets without WHATWG URL's dot-segment/backslash/authority rewriting.
 * Use the very same pinned matcher/defaults as HttpRouter to detect protected route aliases,
 * then require their canonical spelling. No hand-maintained lowercase/percent/slash substitute.
 * Ordinary encoded asset/thread paths remain available. Invalid encoding anywhere fails closed.
 */
export const authTarget = (
  target: string,
): { readonly path: string; readonly searchParams: URLSearchParams } | undefined => {
  if (
    !target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("#") ||
    [...target].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return undefined;
  try {
    // Validate percent escapes AND UTF-8, including the query. Do not use decoded text to route.
    const decoded = decodeURI(target);
    if (
      [...decoded].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return undefined;
    const queryAt = target.indexOf("?");
    const path = queryAt === -1 ? target : target.slice(0, queryAt);
    if (
      path.includes("//") ||
      path.split("/").some((segment) => segment === "." || segment === "..")
    )
      return undefined;
    const protectedPath = protectedRoutes.find("GET", target)?.handler;
    if (protectedPath !== undefined && path !== protectedPath) return undefined;
    const searchParams = new URLSearchParams(queryAt === -1 ? "" : target.slice(queryAt + 1));
    if (searchParams.has("boot") && path !== "/") return undefined;
    return { path, searchParams };
  } catch {
    return undefined;
  }
};
