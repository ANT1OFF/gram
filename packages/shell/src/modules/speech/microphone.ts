import type { MicrophoneAccess } from "@gram/contracts";

/** macOS System Settings → Privacy & Security → Microphone. */
export const PRIVACY_MICROPHONE_URL_MAC =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
/** Windows Settings → Privacy & security → Microphone. */
export const PRIVACY_MICROPHONE_URL_WIN = "ms-settings:privacy-microphone";

/** The slice of Electron's `systemPreferences` this needs. */
export interface MediaAccess {
  getMediaAccessStatus(mediaType: "microphone"): string;
  askForMediaAccess?(mediaType: "microphone"): Promise<boolean>;
}

const ACCESS: ReadonlyArray<MicrophoneAccess> = [
  "granted",
  "denied",
  "restricted",
  "not-determined",
];
const isAccess = (status: string): status is MicrophoneAccess =>
  ACCESS.some((each) => each === status);

/** The microphone permission now; `unknown` where the OS doesn't say (Linux) or says something new. */
export function microphoneAccess(media: MediaAccess, platform: NodeJS.Platform): MicrophoneAccess {
  if (platform !== "darwin" && platform !== "win32") return "unknown";
  try {
    const status = media.getMediaAccessStatus("microphone");
    return isAccess(status) ? status : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Asks macOS for the microphone. It prompts only while access is `not-determined`; after that it
 * answers from the user's earlier choice, which only System Settings changes. Elsewhere, reports.
 */
export async function requestMicrophoneAccess(
  media: MediaAccess,
  platform: NodeJS.Platform,
): Promise<MicrophoneAccess> {
  if (platform === "darwin" && media.askForMediaAccess !== undefined) {
    try {
      await media.askForMediaAccess("microphone");
    } catch (_answeredBelowFromTheStatusWhichIsWhatThe) {}
  }
  return microphoneAccess(media, platform);
}

/** Opens the microphone privacy settings; false where there are none or they didn't open. */
export async function openMicrophoneSettings(deps: {
  readonly platform: NodeJS.Platform;
  readonly openExternal: (url: string) => Promise<void>;
}): Promise<boolean> {
  const url =
    deps.platform === "darwin"
      ? PRIVACY_MICROPHONE_URL_MAC
      : deps.platform === "win32"
        ? PRIVACY_MICROPHONE_URL_WIN
        : undefined;
  if (url === undefined) return false;
  try {
    await deps.openExternal(url);
    return true;
  } catch {
    return false;
  }
}
