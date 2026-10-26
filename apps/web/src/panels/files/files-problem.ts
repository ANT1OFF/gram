import { errorMessage, isNotImplemented } from "@/api/errors";

/** A failed `fs.list` / `fs.file` in the user's terms. */
export function filesProblem(error: unknown): string {
  if (isNotImplemented(error)) return "Files aren't available on this server yet.";
  const tag = typeof error === "object" && error !== null ? Reflect.get(error, "_tag") : undefined;
  if (tag === "NotFound") {
    const message = Reflect.get(error as object, "message");
    return typeof message === "string" && message !== "" ? message : "This file no longer exists.";
  }
  return errorMessage(error);
}
