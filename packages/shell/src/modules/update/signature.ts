/** Public signer pin is unset. Updates stay disabled until release signing is configured. */
export const EXPECTED_SIGNER_CERT_SHA256 = "UNCONFIGURED";

export type SignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Quotes a string as one PowerShell single-quoted literal. */
export function psSingleQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** The product name electron-builder writes into the installer's version resource. */
export const EXPECTED_PRODUCT_NAME = "Gram";

/**
 * The PowerShell probe for `evaluateSignature` and `evaluateInstallerIdentity`: prints `STATUS=`,
 * `SUBJECT=` and, when there is a signer certificate, `SHA256=` of its DER bytes, then the version
 * resource's `PRODUCT=` and `VERSION=`. The hash line is guarded because `ComputeHash($null)` would
 * throw and take the STATUS line with it; the version lines come last for the same reason.
 */
export function authenticodeScript(installer: string): string {
  const path = psSingleQuote(installer);
  return [
    "$ErrorActionPreference='Stop'",
    `$s = Get-AuthenticodeSignature -LiteralPath ${path}`,
    "Write-Output ('STATUS=' + $s.Status)",
    "Write-Output ('SUBJECT=' + $s.SignerCertificate.Subject)",
    "if ($s.SignerCertificate) { $h = [System.Security.Cryptography.SHA256]::Create().ComputeHash($s.SignerCertificate.RawData); Write-Output ('SHA256=' + ([System.BitConverter]::ToString($h) -replace '-','')) }",
    `$v = (Get-Item -LiteralPath ${path}).VersionInfo`,
    "Write-Output ('PRODUCT=' + $v.ProductName)",
    "Write-Output ('VERSION=' + $v.ProductVersion)",
  ].join("; ");
}

/** One `KEY=` line's value from the probe's stdout; empty when it's missing. */
function probeField(psStdout: string, key: string): string {
  const lines = psStdout.split("\n").map((l) => l.replace(/^\uFEFF/, "").trimStart());
  return (
    lines
      .find((l) => l.startsWith(key))
      ?.slice(key.length)
      .trim() ?? ""
  );
}

/**
 * Decides from the probe's stdout whether the installer is ours. `Status` must be `Valid` (trusted
 * chain and untampered file) and the signer fingerprint must equal the pin. The subject plays no
 * part in the decision; it's only echoed to make a rejection diagnosable. Missing or garbled
 * output fails closed.
 */
export function evaluateSignature(
  psStdout: string,
  expectedSha256: string = EXPECTED_SIGNER_CERT_SHA256,
): SignatureVerdict {
  const field = (key: string) => probeField(psStdout, key);
  const status = field("STATUS=");
  const subject = field("SUBJECT=");
  const sha256 = field("SHA256=");

  if (!/^[a-f\d]{64}$/i.test(expectedSha256)) {
    return { ok: false, error: "installer signing is not configured" };
  }

  if (status !== "Valid") {
    return {
      ok: false,
      error: `installer signature is not valid (status: ${status || "unknown"})`,
    };
  }
  if (!/^[a-f\d]{64}$/i.test(sha256) || sha256.toUpperCase() !== expectedSha256.toUpperCase()) {
    return {
      ok: false,
      error: `installer signed by an unexpected certificate (subject: ${subject || "unknown"}; sha256: ${sha256 || "unavailable"})`,
    };
  }
  return { ok: true };
}

/**
 * Decides from the same probe's stdout whether the installer is the release it was downloaded for:
 * its version resource must name `productName` and exactly `version`, the tag's. A genuinely signed
 * installer of another release, or another signed EXAMPLE program, fails here. Missing output fails
 * closed.
 */
export function evaluateInstallerIdentity(
  psStdout: string,
  version: string,
  productName: string = EXPECTED_PRODUCT_NAME,
): SignatureVerdict {
  const product = probeField(psStdout, "PRODUCT=");
  const found = probeField(psStdout, "VERSION=");
  if (product !== productName) {
    return {
      ok: false,
      error: `installer is not ${productName} (product: ${product || "unknown"})`,
    };
  }
  if (found !== version) {
    return {
      ok: false,
      error: `installer is version ${found || "unknown"}, not the release's ${version}`,
    };
  }
  return { ok: true };
}
