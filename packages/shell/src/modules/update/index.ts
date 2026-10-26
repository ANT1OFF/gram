// Shared update policy, artifact validation and installation. Platform installers enforce their
// own trust boundaries: Developer ID signed macOS installs update through Electron's updater (in
// `apps/desktop/src/main/update`) against the publisher's team, and Windows requires a valid
// signer. Unsigned macOS builds have no in-app updater. Desktop process adapters supply bounded
// GitHub/signature probes from `apps/desktop/src/main/update/process.ts`.
export * from "./config.ts";
export * from "./install.ts";
export * from "./native-record.ts";
export * from "./native-release.ts";
export * from "./native-state.ts";
export * from "./policy.ts";
export * from "./releases.ts";
export * from "./semver.ts";
export * from "./signature.ts";
export * from "./source.ts";
export * from "./sweep.ts";
export * from "./updater.ts";
export * from "./update-source.ts";

// The signed macOS updater's candidate checks: its bounded ZIP reader, bundle identity and
// macOS's own signature verdict, and where an installation may be replaced.
export * from "./mac-archive.ts";
export { verifyBundleIdentity } from "./mac-bundle.ts";
export { macArtifactName, sourceFailure } from "./mac-artifacts.ts";
export type { MacArtifactMethod } from "./mac-artifacts.ts";
export * from "./mac-signature.ts";
export * from "./mac-target.ts";
