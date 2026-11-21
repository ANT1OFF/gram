/**
 * A server's name as an orchestrator reads it, in its prompt and its tools' words: one line of
 * printable text, at most 60 characters, so a name can't pass for instructions.
 */
export const plainName = (name: string): string => {
  const flat = [...name]
    .map((char) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...flat].slice(0, 60).join("");
  return cut === "" ? "The hosted server" : cut;
};
