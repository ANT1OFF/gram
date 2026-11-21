/**
 * A computer's name as a sign-in sends it, so the server can list the sign-in under it and a
 * person with several computers tells them apart: one line, at most 64 characters, or nothing.
 */
export const sentDeviceName = (name: string | undefined): string | undefined => {
  const line = [...(name ?? "").replace(/\p{Cc}+/gu, " ").trim()].slice(0, 64).join("").trim();
  return line === "" ? undefined : line;
};
