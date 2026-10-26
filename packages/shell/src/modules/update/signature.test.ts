import { describe, expect, it } from "vitest";

import {
  authenticodeScript,
  EXPECTED_SIGNER_CERT_SHA256,
  evaluateInstallerIdentity,
  evaluateSignature,
  psSingleQuote,
} from "./signature.ts";

const TEST_SIGNER = "A1".repeat(32);
const REAL_SUBJECT = "CN=Synthetic Test Signer";
const probe = (sha256: string) => `STATUS=Valid\nSUBJECT=${REAL_SUBJECT}\nSHA256=${sha256}\n`;
const error = (stdout: string) => {
  const verdict = evaluateSignature(stdout, TEST_SIGNER);
  if (verdict.ok) throw new Error("expected a rejection");
  return verdict.error;
};

describe("evaluateSignature", () => {
  it("refuses all certificates while Gram signing is unconfigured", () => {
    for (const sha of [EXPECTED_SIGNER_CERT_SHA256, TEST_SIGNER])
      expect(evaluateSignature(probe(sha))).toEqual({
        ok: false,
        error: "installer signing is not configured",
      });
  });
  it("accepts the pinned certificate in any hex case, with BOM and CRLF quirks", () => {
    expect(evaluateSignature(probe(TEST_SIGNER), TEST_SIGNER)).toEqual({ ok: true });
    expect(evaluateSignature(probe(TEST_SIGNER.toLowerCase()), TEST_SIGNER)).toEqual({
      ok: true,
    });
    const quirky = `\uFEFFSTATUS=Valid\r\n  SUBJECT=${REAL_SUBJECT}\r\nSHA256=${TEST_SIGNER}\r\n`;
    expect(evaluateSignature(quirky, TEST_SIGNER)).toEqual({ ok: true });
  });

  it("requires a Valid status even with the right fingerprint", () => {
    expect(error(probe(TEST_SIGNER).replace("STATUS=Valid", "STATUS=HashMismatch"))).toContain(
      "HashMismatch",
    );
    expect(error("STATUS=NotSigned\nSUBJECT=\n")).toContain("NotSigned");
    expect(error("")).toContain("unknown");
  });

  it("rejects any other certificate, whatever its subject says", () => {
    const wrong = "AB".repeat(32);
    const e = error(probe(wrong));
    expect(e).toContain("unexpected certificate");
    expect(e).toContain(wrong);
  });

  it("fails closed on a missing or truncated fingerprint", () => {
    const missing = error(`STATUS=Valid\nSUBJECT=${REAL_SUBJECT}\n`);
    expect(missing).toContain("unexpected certificate");
    expect(missing).toContain("unavailable");
    expect(error(probe(TEST_SIGNER.slice(0, 32)))).toContain("unexpected certificate");
  });
});

const identity = (product: string, version: string) =>
  `${probe(TEST_SIGNER)}PRODUCT=${product}\r\nVERSION=${version}\r\n`;

describe("evaluateInstallerIdentity", () => {
  it("accepts Gram at exactly the release's version", () => {
    expect(evaluateInstallerIdentity(identity("Gram", "1.2.0-rc.1"), "1.2.0-rc.1")).toEqual({
      ok: true,
    });
  });

  it("rejects another version, another product, or a probe that didn't say", () => {
    for (const [stdout, expected] of [
      [identity("Gram", "1.1.0"), "installer is version 1.1.0, not the release's 1.2.0"],
      [identity("Gram", "1.2.0.0"), "version 1.2.0.0"],
      [identity("Gram Helper", "1.2.0"), "installer is not Gram"],
      [probe(TEST_SIGNER), "product: unknown"],
    ] as const) {
      const verdict = evaluateInstallerIdentity(stdout, "1.2.0");
      expect(verdict.ok, stdout).toBe(false);
      if (!verdict.ok) expect(verdict.error).toContain(expected);
    }
  });
});

describe("authenticodeScript", () => {
  it("quotes the installer path as a single PowerShell literal", () => {
    expect(psSingleQuote("C:\\Users\\o'neil\\x-setup.exe")).toBe(
      "'C:\\Users\\o''neil\\x-setup.exe'",
    );
    expect(authenticodeScript("C:\\a'b.exe")).toContain("-LiteralPath 'C:\\a''b.exe'");
  });

  it("reads the version resource after the signature, from the same literal path", () => {
    const script = authenticodeScript("C:\\a'b.exe");
    expect(script).toContain("(Get-Item -LiteralPath 'C:\\a''b.exe').VersionInfo");
    expect(script.indexOf("SHA256=")).toBeLessThan(script.indexOf("PRODUCT="));
    expect(script).toContain("'VERSION=' + $v.ProductVersion");
  });
});
