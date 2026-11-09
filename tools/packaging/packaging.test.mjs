import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { seedChecksums } from "./cache.mjs";
import { isTransientDownloadFailure, retryPackaging } from "./retry.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requireBuilder = createRequire(join(root, "node_modules/app-builder-lib/package.json"));
const { downloadArtifact } = requireBuilder("@electron/get");
const { buildElectronArtifactConfig } = requireBuilder("./out/util/electronGet.js");
const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "gram-packaging-test-"));
  temporary.push(path);
  return path;
};
const failure = {
  code: 1,
  output:
    "⨯ Response code 504 (Gateway Time-out) failedTask=build stackTrace=HTTPError: Response code 504 (Gateway Time-out)",
};

describe("packaging download retries", () => {
  it("retries a simulated upstream 504, with bounded backoff", async () => {
    let calls = 0;
    const delays = [];
    const code = await retryPackaging(
      async () => (++calls < 3 ? failure : { code: 0 }),
      async (ms) => delays.push(ms),
      () => {},
    );
    expect({ calls, delays, code }).toEqual({ calls: 3, delays: [10000, 20000], code: 0 });
  });

  it("fails after three persistent download failures and preserves the exit code", async () => {
    let calls = 0;
    const code = await retryPackaging(
      async () => {
        calls++;
        return { ...failure, code: 7 };
      },
      async () => {},
      () => {},
    );
    expect({ calls, code }).toEqual({ calls: 3, code: 7 });
  });

  it.each([
    "⨯ Application entry file does not exist",
    "⨯ sha256 checksum mismatch",
    "⨯ Response code 404 (Not Found) stackTrace=HTTPError: Response code 404",
    "download https://example.invalid/504\n⨯ Invalid configuration object",
    "HTTPError: Response code 504\n⨯ afterPack failed: missing native binary",
  ])("fails fast on a real build error: %s", async (output) => {
    let calls = 0;
    const code = await retryPackaging(
      async () => {
        calls++;
        return { code: 2, output };
      },
      () => {
        throw new Error("must not wait");
      },
    );
    expect({ calls, code }).toEqual({ calls: 1, code: 2 });
  });

  it.each([
    "⨯ socket hang up failedTask=build stackTrace=RequestError: socket hang up",
    "⨯ connect ETIMEDOUT stackTrace=RequestError: connect ETIMEDOUT",
    "RequestError: getaddrinfo EAI_AGAIN github.com",
    "TimeoutError: ETIMEDOUT",
    "⨯ cannot execute cause=HTTP status code 503",
  ])("recognizes a downloader transport failure: %s", (output) => {
    expect(isTransientDownloadFailure(output)).toBe(true);
  });

  it("does not retry a cancelled packaging child", async () => {
    let calls = 0;
    expect(
      await retryPackaging(async () => {
        calls++;
        return { ...failure, signal: "SIGTERM" };
      }),
    ).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("Electron checksum cache", () => {
  it("reproduces the post-ZIP 504, then validates a cache hit with no downloads", async () => {
    const cacheRoot = temp();
    const version = "45.0.0";
    const filename = `electron-v${version}-linux-x64.zip`;
    const payload = "synthetic Electron ZIP bytes; never executed or extracted";
    const checksums = { [filename]: createHash("sha256").update(payload).digest("hex") };
    const urls = [];
    const config = {
      version,
      platform: "linux",
      arch: "x64",
      artifactName: "electron",
      cacheRoot,
      downloader: {
        download: async (url, target) => {
          urls.push(url);
          if (url.endsWith("SHASUMS256.txt"))
            throw new Error("Response code 504 (Gateway Time-out)");
          writeFileSync(target, payload);
        },
      },
    };
    await expect(downloadArtifact(config)).rejects.toThrow("Response code 504");
    expect(urls).toEqual([
      `https://github.com/electron/electron/releases/download/v${version}/${filename}`,
      `https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`,
    ]);

    seedChecksums(cacheRoot, version, checksums);
    const seeded = await buildElectronArtifactConfig({
      version,
      platformName: "linux",
      arch: "x64",
      artifactName: "electron",
      cacheDir: cacheRoot,
    });
    expect(seeded.checksums).toEqual(checksums);
    const file = await downloadArtifact({ ...config, ...seeded });
    expect(readFileSync(file, "utf8")).toBe(payload);
    const afterFill = urls.length;
    expect(
      await downloadArtifact({
        ...config,
        ...seeded,
        downloader: {
          download: () => {
            throw new Error("network forbidden on hit");
          },
        },
      }),
    ).toBe(file);
    expect(urls).toHaveLength(afterFill);

    writeFileSync(file, "corrupted cache");
    await expect(
      downloadArtifact({
        ...config,
        ...seeded,
        downloader: {
          download: () => {
            throw new Error("corruption requires re-download");
          },
        },
      }),
    ).rejects.toThrow("corruption requires re-download");
  });

  it("refuses malformed checksum inputs", () => {
    expect(() => seedChecksums(temp(), "45.0.0", {})).toThrow("Invalid Electron checksums");
    expect(() => seedChecksums(temp(), "45.0.0", { bad: "not a hash" })).toThrow(
      "Invalid Electron checksums",
    );
  });
});

describe("release builder archive cache", () => {
  it("re-hashes cached tool archives before extraction and rejects corrupted bytes", async () => {
    const cacheRoot = temp();
    vi.stubEnv("ELECTRON_BUILDER_CACHE", cacheRoot);
    const { mkdirSync } = await import("node:fs");
    const { create } = requireBuilder("tar");
    const releaseName = "synthetic-tool@1.0.0";
    const filenameWithExt = "synthetic-tool.tar.gz";
    const source = join(temp(), "tool");
    mkdirSync(source);
    writeFileSync(join(source, "runtime"), "invented runtime; never executed");
    const archiveDir = join(cacheRoot, releaseName);
    mkdirSync(archiveDir);
    const archive = join(archiveDir, filenameWithExt);
    await create({ file: archive, gzip: true, cwd: join(source, "..") }, ["tool"]);
    const checksums = {
      [filenameWithExt]: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    };
    const network = vi
      .spyOn(requireBuilder("@electron/get"), "downloadArtifact")
      .mockRejectedValue(new Error("network forbidden for synthetic archive test"));
    const { downloadBuilderToolset } = requireBuilder("./out/util/electronGet.js");
    const options = { releaseName, filenameWithExt, checksums };
    const extracted = await downloadBuilderToolset(options);
    expect(readFileSync(join(extracted, "runtime"), "utf8")).toBe(
      "invented runtime; never executed",
    );
    expect(network).not.toHaveBeenCalled();

    // A fresh release restores archives only, so no extracted state can bypass this hash check.
    rmSync(extracted, { recursive: true });
    writeFileSync(archive, "corrupted cached tool archive");
    await expect(downloadBuilderToolset(options)).rejects.toThrow("network forbidden");
    expect(network).toHaveBeenCalledOnce();
  });
});
