import { errorMessage, isNotFound, isNotImplemented } from "@/api/errors";

/** A failed `fs.list` / `fs.file` in the user's terms. */
export function filesProblem(error: unknown): string {
  if (isNotImplemented(error)) return "Files aren't available on this server yet.";
  if (isNotFound(error) && typeof error === "object" && error !== null) {
    const message = "message" in error ? error.message : undefined;
    return typeof message === "string" && message !== "" ? message : "This file no longer exists.";
  }
  return errorMessage(error);
}
