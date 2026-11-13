import { describe, expect, it } from "vitest";

import {
  isPreviewFilesUrl,
  loopbackUrl,
  previewAddress,
  previewFileKind,
  previewFileTarget,
  previewUrl,
  webUrl,
} from "./preview.ts";

describe("the preview rule", () => {
  it("takes a port or a loopback http(s) URL", () => {
    expect(previewUrl("3000")).toBe("http://127.0.0.1:3000/");
    expect(previewUrl(":5173")).toBe("http://127.0.0.1:5173/");
    expect(previewUrl("http://localhost:8080/app")).toBe("http://localhost:8080/app");
    expect(previewUrl(" https://127.0.0.1:8443/ ")).toBe("https://127.0.0.1:8443/");
    expect(previewUrl("http://[::1]:3000")).toBe("http://[::1]:3000/");
  });

  it("refuses every other host, scheme and port", () => {
    expect(previewUrl("https://organization.example.invalid")).toBeUndefined();
    expect(previewUrl("http://organization.example.invalid:3000/")).toBeUndefined();
    expect(previewUrl("http://127.0.0.2:3000/")).toBeUndefined();
    expect(previewUrl("file:///etc/passwd")).toBeUndefined();
    expect(previewUrl("javascript:alert(1)")).toBeUndefined();
    expect(previewUrl("99999")).toBeUndefined();
    expect(previewUrl("0")).toBeUndefined();
  });

  it("takes a typed loopback address without its scheme", () => {
    expect(previewAddress("localhost:3000")).toBe("http://localhost:3000/");
    expect(previewAddress(" 127.0.0.1:5173/app?x=1 ")).toBe("http://127.0.0.1:5173/app?x=1");
    expect(previewAddress("[::1]:8080")).toBe("http://[::1]:8080/");
    expect(previewAddress("3000")).toBe("http://127.0.0.1:3000/");
    expect(previewAddress("https://localhost:8443/")).toBe("https://localhost:8443/");
    expect(previewAddress("localhost:3000@evil.example")).toBeUndefined();
    expect(previewAddress("javascript:alert(1)")).toBeUndefined();
    expect(previewAddress("file:///etc/passwd")).toBeUndefined();
    // The strict rule the bridge keeps to still wants a scheme.
    expect(previewUrl("localhost:3000")).toBeUndefined();
  });

  it("takes a typed web address on any host, https unless it says or is an IPv4 address", () => {
    expect(previewAddress("organization.example.invalid")).toBe(
      "https://organization.example.invalid/",
    );
    expect(previewAddress("example.com/docs?q=1")).toBe("https://example.com/docs?q=1");
    expect(previewAddress("http://example.com:8080/")).toBe("http://example.com:8080/");
    expect(previewAddress("https://example.com/")).toBe("https://example.com/");
    expect(previewAddress("192.168.1.1")).toBe("http://192.168.1.1/");
    expect(previewAddress("10.0.0.2:8080/admin")).toBe("http://10.0.0.2:8080/admin");
    // A word, a relative file name or a phrase isn't an address.
    expect(previewAddress("intranet")).toBeUndefined();
    expect(previewAddress("README.md")).toBeUndefined();
    expect(previewAddress("docs/a.md")).toBeUndefined();
    expect(previewAddress("how do I")).toBeUndefined();
    expect(previewAddress("user@example.com")).toBeUndefined();
    expect(previewAddress("https://user:pw@example.com/")).toBeUndefined();
  });

  it("opens any http(s) page for the user, and no other scheme", () => {
    expect(webUrl("https://example.com/a#b")).toBe("https://example.com/a#b");
    expect(webUrl(" http://203.0.113.9:8080 ")).toBe("http://203.0.113.9:8080/");
    expect(webUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
    for (const refused of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/0f0e",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "about:blank",
      "view-source:https://example.com/",
      "ftp://example.com/",
      "mailto:a@example.com",
      "https://evil.example@example.com/",
      "not a url",
    ]) {
      expect(webUrl(refused), refused).toBeUndefined();
    }
  });

  it("refuses a user name before the host, which a look-alike would hide behind", () => {
    expect(loopbackUrl("http://evil.example@localhost:3000/")).toBeUndefined();
    expect(loopbackUrl("http://localhost:3000@evil.example/")).toBeUndefined();
    expect(loopbackUrl("not a url")).toBeUndefined();
  });
});

describe("preview files", () => {
  it("knows Markdown and HTML by extension, and takes only an absolute path as a target", () => {
    expect(previewFileKind("/r/README.md")).toBe("markdown");
    expect(previewFileKind("notes.MARKDOWN")).toBe("markdown");
    expect(previewFileKind("/tmp/dash.htm")).toBe("html");
    expect(previewFileKind("/tmp/app.ts")).toBeUndefined();
    expect(previewFileTarget("/tmp/x/dashboard.html")).toBe("/tmp/x/dashboard.html");
    expect(previewFileTarget(" ~/notes/a.md ")).toBe("~/notes/a.md");
    expect(previewFileTarget("C:\\work\\report.html")).toBe("C:\\work\\report.html");
    expect(previewFileTarget("docs/a.md")).toBeUndefined();
    expect(previewFileTarget("/tmp/a.txt")).toBeUndefined();
  });

  it("tells the file listener's pages apart on any loopback port, however the path is spelled", () => {
    expect(isPreviewFilesUrl("http://127.0.0.1:52011/gram-preview-files/tok/index.html")).toBe(
      true,
    );
    expect(isPreviewFilesUrl("http://localhost:9/./gram-preview-files/tok/a.css")).toBe(true);
    expect(isPreviewFilesUrl("http://127.0.0.1:9/%67ram-preview-files/tok/")).toBe(true);
    expect(isPreviewFilesUrl("http://127.0.0.1:9/GRAM-Preview-Files/tok/")).toBe(true);
    expect(isPreviewFilesUrl("http://127.0.0.1:3000/")).toBe(false);
    expect(isPreviewFilesUrl("http://127.0.0.1:3000/docs/gram-preview-files/")).toBe(false);
    expect(isPreviewFilesUrl("https://organization.example.invalid/gram-preview-files/tok/")).toBe(
      false,
    );
  });
});
