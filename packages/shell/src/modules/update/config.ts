/**
 * The public GitHub repo releases are published to. Signed macOS installs read its releases
 * anonymously. The `gh` updater (Windows) reads them through the user's own `gh` login, always
 * with an explicit `--repo`, so the working directory never matters, and reports `unavailable`
 * rather than failing without one. `null` means no update channel: no check runs, automatic or
 * manual.
 */
export const UPDATE_REPO: string | null = "ANT1OFF/gram";

/**
 * The Windows NSIS installer asset's name: electron-builder's `artifactName` with the one arch
 * Windows builds for. `${version}` is the release tag's, so an installer renamed onto another
 * release, or any other signed `-setup.exe` beside it, is never the one downloaded.
 */
export const INSTALLER_PATTERN = "gram_${version}_x64-setup.exe";

/** The installer asset `version`'s release must carry. */
export const installerAssetName = (version: string): string =>
  INSTALLER_PATTERN.replace("${version}", version);

/** Name prefix of the per-download installer temp dirs; the sweep only ever removes these. */
export const UPDATE_DIR_PREFIX = "gram-update-";

/**
 * How old a leftover installer dir must be before the sweep removes it. Generous on purpose: a
 * younger dir could belong to a download or an installer run still in flight (the success path
 * leaves its dir behind, because the installer runs from it while the app exits).
 */
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The free space an update needs where it downloads: the installer (about 120 MB) and the app it
 * unpacks (about 430 MB) beside the installed one, with room to spare. A disk that filled up
 * mid-download failed an update with a bare `ENOSPC`; this is checked first instead.
 */
export const UPDATE_MIN_FREE_BYTES = 1024 * 1024 * 1024;
