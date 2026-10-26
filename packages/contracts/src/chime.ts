import * as Schema from "effect/Schema";

/** The built-in notification sounds; `notifications.sounds: false` is None. */
export const ChimeSound = Schema.Literals(["chime", "bell", "pop", "marimba"]);
export type ChimeSound = typeof ChimeSound.Type;

export const DEFAULT_CHIME: ChimeSound = "chime";

/** The configured sound, or `undefined` for None; settings without a choice get the default. */
export const chimeOf = (notifications: {
  readonly sounds: boolean;
  readonly chime?: ChimeSound;
}): ChimeSound | undefined =>
  notifications.sounds ? (notifications.chime ?? DEFAULT_CHIME) : undefined;
