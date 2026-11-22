import type { HostHello } from "@gram/contracts";

/** The release a host said it runs, kept only when it reads as a release: it is shown as text. */
export const releaseOf = (hello: HostHello): string | undefined =>
  hello.release !== undefined &&
  /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/.test(hello.release)
    ? hello.release
    : undefined;

/**
 * This Gram's release, which the installer downloads and machines update to: its version, only when
 * it was built as a release (its build is a commit); undefined when it runs from source.
 */
export const releaseOfConfig = (config: {
  readonly appVersion?: string | undefined;
  readonly appBuild?: string | undefined;
}): string | undefined =>
  config.appBuild !== undefined && /^[a-f0-9]{40}$/.test(config.appBuild)
    ? config.appVersion
    : undefined;
