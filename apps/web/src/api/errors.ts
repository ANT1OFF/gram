const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && typeof Reflect.get(error, "_tag") === "string"
    ? (Reflect.get(error, "_tag") as string)
    : undefined;

/** The server has no handler for this RPC yet (W1–W4 land them one group at a time). */
export const isNotImplemented = (error: unknown): boolean => tagOf(error) === "NotImplemented";

/** What a request named is gone, or never existed on this server: any `NotFound`. */
export const isNotFound = (error: unknown): boolean => tagOf(error) === "NotFound";

/** The thread is gone: closed, deleted, or never existed on this server. */
export const isThreadNotFound = (error: unknown): boolean => tagOf(error) === "ThreadNotFound";

/** A short message fit for the UI, for a contract tagged error or anything else thrown. */
export function errorMessage(error: unknown): string {
  if (isNotImplemented(error)) return "Not available yet";
  const message =
    typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
  if (typeof message === "string" && message !== "") return message;
  return tagOf(error) ?? String(error);
}

/** A missing or unreadable thread folder in the user's terms; `undefined` for any other error. */
export function folderProblem(error: unknown): string | undefined {
  const tag = tagOf(error);
  const message = errorMessage(error);
  if (tag === "NotFound" && Reflect.get(error as object, "entity") === "project") {
    return "This thread's folder doesn't exist.";
  }
  if (tag === "InvalidState" && message.startsWith("Not a folder")) {
    return "This thread's folder isn't a folder.";
  }
  // The server's permission messages are already written for the user.
  if (tag === "InvalidState" && /can't read|Permission denied/.test(message)) return message;
  if (/folder no longer exists|FileSystem\.access|ENOENT|no such file or directory/.test(message)) {
    return "This thread's folder doesn't exist.";
  }
  return undefined;
}

/** The path a `CheckoutInUse` refusal names; `undefined` for any other error. */
export function checkoutInUsePath(error: unknown): string | undefined {
  if (tagOf(error) !== "CheckoutInUse") return undefined;
  const path = Reflect.get(error as object, "path");
  return typeof path === "string" ? path : undefined;
}

/** A failed `thread.rewind` in the user's terms. */
export function rewindErrorMessage(error: unknown): string {
  if (isNotImplemented(error)) return "Rewind isn't available yet.";
  if (tagOf(error) === "InvalidState") return `Can't rewind right now: ${errorMessage(error)}`;
  return errorMessage(error);
}
