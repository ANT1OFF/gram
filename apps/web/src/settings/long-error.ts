/** Over this many characters an error is clamped until opened. */
const LONG_ERROR = 180;

/** Whether an error is long enough to clamp: many characters, or more than one line. */
export const isLongError = (message: string): boolean =>
  message.length > LONG_ERROR || message.trim().includes("\n");
