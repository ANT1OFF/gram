import type { AppBuildInfo } from "@gram/contracts";

declare const GRAM_BUILD_SOURCE: string | null;

/** Only packaged, clean-build provenance identifies the source of a running binary. */
export function runningBuildInfo(version: string, packaged: boolean): AppBuildInfo {
  const source = typeof GRAM_BUILD_SOURCE === "undefined" ? null : GRAM_BUILD_SOURCE;
  return {
    version,
    packaged,
    ...(packaged && typeof source === "string" && /^[a-f0-9]{40}$/.test(source)
      ? { sourceCommit: source }
      : {}),
  };
}

/** The server's `GRAM_APP_BUILD`: a packaged build's source commit, or `dev` for one run from source. */
export function appBuildEnv(info: AppBuildInfo): { readonly GRAM_APP_BUILD?: string } {
  if (info.sourceCommit !== undefined) return { GRAM_APP_BUILD: info.sourceCommit };
  return info.packaged ? {} : { GRAM_APP_BUILD: "dev" };
}
