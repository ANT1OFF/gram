// Canonical known text signatures shared by source and documentation checks.
export const forbiddenReference = new RegExp(
  ["nb(?:im)", "nb\\.im", "norges-bank\\.no", "jfrog-token-rotation", "aiusage"].join("|"),
  "i",
);
// The project's former names. Split so this definition does not match itself.
export const formerName = new RegExp(
  [
    ["switch", "board"],
    ["cc.?man", "ager"],
    ["claude.?(?:code.?)?man", "ager"],
    ["\\bcc", "m\\b"],
  ]
    .map((parts) => parts.join(""))
    .join("|"),
  "i",
);
export const embeddedCredential =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/;

// Report locations/types only; never print matching identifiers or credential-like values.
export const textBoundaryIssues = (content) =>
  [
    [forbiddenReference, "internal organization reference"],
    [embeddedCredential, "possible embedded credential"],
  ].flatMap(([pattern, message]) => {
    const match = pattern.exec(content);
    return match ? [{ line: content.slice(0, match.index).split("\n").length, message }] : [];
  });
