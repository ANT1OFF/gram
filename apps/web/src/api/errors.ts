/** The `_tag` a failed RPC's error carries; undefined for anything else. */
export const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
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
    typeof error === "object" && error !== null && "message" in error ? error.message : undefined;
  if (typeof message === "string" && message !== "") return message;
  return tagOf(error) ?? String(error);
}

/** Where a refusal says the person can put it right: an https page and its words, when it says. */
export function errorHelp(error: unknown): { url: string; label: string } | undefined {
  if (tagOf(error) !== "InvalidState" || typeof error !== "object" || error === null)
    return undefined;
  const help: unknown = "help" in error ? error.help : undefined;
  if (typeof help !== "object" || help === null) return undefined;
  const url = "url" in help ? help.url : undefined;
  const label = "label" in help ? help.label : undefined;
  if (typeof url !== "string" || typeof label !== "string" || !url.startsWith("https://"))
    return undefined;
  return { url, label };
}

/** A missing or unreadable thread folder in the user's terms; `undefined` for any other error. */
export function folderProblem(error: unknown): string | undefined {
  const tag = tagOf(error);
  const message = errorMessage(error);
  if (
    tag === "NotFound" &&
    typeof error === "object" &&
    error !== null &&
    "entity" in error &&
    error.entity === "project"
  ) {
    return "This thread's folder doesn't exist.";
  }
  if (tag === "InvalidState" && message.startsWith("Not a folder")) {
    return "This thread's folder isn't a folder.";
  }
  if (tag === "InvalidState" && /can't read|Permission denied/.test(message)) return message;
  if (/folder no longer exists|FileSystem\.access|ENOENT|no such file or directory/.test(message)) {
    return "This thread's folder doesn't exist.";
  }
  return undefined;
}

/** The path a `CheckoutInUse` refusal names; `undefined` for any other error. */
export function checkoutInUsePath(error: unknown): string | undefined {
  if (tagOf(error) !== "CheckoutInUse" || typeof error !== "object" || error === null)
    return undefined;
  const path = "path" in error ? error.path : undefined;
  return typeof path === "string" ? path : undefined;
}

/** A failed `thread.undoTurn` in the user's terms: the server's refusals are written for the user. */
export function undoTurnErrorMessage(error: unknown): string {
  if (isNotImplemented(error)) return "Undo isn't available on this server yet.";
  return errorMessage(error);
}

/** A failed `thread.rewind` in the user's terms. */
export function rewindErrorMessage(error: unknown): string {
  if (isNotImplemented(error)) return "Rewind isn't available yet.";
  if (tagOf(error) === "InvalidState") return `Can't rewind right now: ${errorMessage(error)}`;
  return errorMessage(error);
}
