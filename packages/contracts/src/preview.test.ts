import { describe, expect, it } from "vitest";

import {
  isPreviewFilesUrl,
  loopbackUrl,
  previewAddress,
  previewFileKind,
  previewFileTarget,
  previewUrl,
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

  it("takes a typed loopback address without its scheme, and nothing more", () => {
    expect(previewAddress("localhost:3000")).toBe("http://localhost:3000/");
    expect(previewAddress(" 127.0.0.1:5173/app?x=1 ")).toBe("http://127.0.0.1:5173/app?x=1");
    expect(previewAddress("[::1]:8080")).toBe("http://[::1]:8080/");
    expect(previewAddress("3000")).toBe("http://127.0.0.1:3000/");
    expect(previewAddress("https://localhost:8443/")).toBe("https://localhost:8443/");
    expect(previewAddress("organization.example.invalid")).toBeUndefined();
    expect(previewAddress("localhost:3000@evil.example")).toBeUndefined();
    expect(previewAddress("javascript:alert(1)")).toBeUndefined();
    expect(previewAddress("file:///etc/passwd")).toBeUndefined();
    // The strict rule the bridge keeps to still wants a scheme.
    expect(previewUrl("localhost:3000")).toBeUndefined();
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
