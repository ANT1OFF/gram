import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { bundleChunks, packageDirOf, packageDirs, writePackageList } from "./bundled-packages.mjs";
import {
  collectPackages,
  declaredLicense,
  readComponents,
  readLists,
  renderNotices,
} from "./generate.mjs";

const fixture = () => mkdtempSync(join(tmpdir(), "gram-notices-"));

/** Writes a package folder under `root`/node_modules with the given manifest and files. */
const addPackage = (root, manifest, files = {}) => {
  const dir = join(root, "node_modules", ...manifest.name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

describe("packageDirOf", () => {
  it("finds the innermost package folder in hoisted, scoped, nested and isolated layouts", () => {
    expect(packageDirOf("/r/node_modules/pino/lib/tools.js")).toBe("/r/node_modules/pino");
    expect(packageDirOf("/r/node_modules/@effect/platform-node/dist/index.js")).toBe(
      "/r/node_modules/@effect/platform-node",
    );
    expect(packageDirOf("/r/node_modules/a/node_modules/semver/index.js")).toBe(
      "/r/node_modules/a/node_modules/semver",
    );
    expect(
      packageDirOf("/r/node_modules/.bun/zod@4.0.0/node_modules/zod/index.js?commonjs-proxy"),
    ).toBe("/r/node_modules/.bun/zod@4.0.0/node_modules/zod");
    expect(packageDirOf("\0/r/node_modules/react/index.js")).toBe("/r/node_modules/react");
  });

  it("skips the app's own source and virtual modules", () => {
    expect(packageDirOf("/r/packages/server/src/main.ts")).toBeUndefined();
    expect(packageDirOf("\0rolldown/runtime.js")).toBeUndefined();
    expect(packageDirOf("/r/node_modules/@scope")).toBeUndefined();
  });

  it("lists each folder once, relative to the root", () => {
    expect(
      packageDirs(
        [
          "/r/node_modules/pino/a.js",
          "/r/node_modules/pino/b.js",
          "/r/src/app.ts",
          "/r/node_modules/@ai-sdk/provider/x.js",
        ],
        "/r",
      ),
    ).toEqual(["node_modules/@ai-sdk/provider", "node_modules/pino"]);
  });
});

describe("bundleChunks", () => {
  it("hashes each chunk as written and keeps only the imports from outside the bundle", () => {
    const code = "var e=require(`node:fs`);";
    const chunks = bundleChunks({
      "server.js": {
        type: "chunk",
        fileName: "server.js",
        code,
        imports: ["node:fs", "chunks/shared.js", "node-pty"],
        dynamicImports: ["@parcel/watcher", "node:fs"],
      },
      "chunks/shared.js": {
        type: "chunk",
        fileName: "chunks/shared.js",
        code: "",
        imports: [],
        dynamicImports: [],
      },
      "ghostty-vt.wasm": { type: "asset", fileName: "ghostty-vt.wasm", source: "" },
    });
    expect(chunks).toEqual([
      {
        file: "chunks/shared.js",
        sha256: createHash("sha256").update("").digest("hex"),
        externals: [],
      },
      {
        file: "server.js",
        sha256: createHash("sha256").update(code).digest("hex"),
        externals: ["@parcel/watcher", "node-pty", "node:fs"],
      },
    ]);
  });

  it("writes the chunks beside the packages", () => {
    const lists = fixture();
    const chunk = { file: "index.js", sha256: "ab", externals: ["electron"] };
    writePackageList("main", ["/r/node_modules/pino/a.js"], lists, [chunk]);
    expect(JSON.parse(readFileSync(join(lists, "main.json"), "utf8")).chunks).toEqual([chunk]);
  });
});

describe("declaredLicense", () => {
  it("reads the license in each package.json shape", () => {
    expect(declaredLicense({ license: "MIT" })).toBe("MIT");
    expect(declaredLicense({ license: { type: "ISC" } })).toBe("ISC");
    expect(declaredLicense({ licenses: [{ type: "MIT" }, "Apache-2.0"] })).toBe(
      "MIT OR Apache-2.0",
    );
    expect(declaredLicense({})).toBe("UNKNOWN");
  });
});

describe("the notices", () => {
  it("fails when a bundle hasn't recorded its packages", () => {
    const lists = fixture();
    writePackageList("main", ["/r/node_modules/pino/a.js"], lists);
    expect(() => readLists(lists, ["main", "server"])).toThrow(/no package list for server/);
    expect(readLists(lists, ["main"]).get("main")).toEqual([
      expect.stringMatching(/node_modules\/pino$/),
    ]);
  });

  it("covers each package once, with where it ships and its own license files", () => {
    const root = fixture();
    const pino = addPackage(
      root,
      {
        name: "pino",
        version: "10.0.0",
        license: "MIT",
        repository: "git+https://github.com/pinojs/pino.git",
      },
      { LICENSE: "The MIT License\r\nCopyright (c) pino\r\n", "license.js": "not a license" },
    );
    addPackage(root, {
      name: "@ai-sdk/provider-utils",
      version: "5.0.0",
      license: "Apache-2.0",
      author: "Vercel <x@y>",
    });
    const pty = addPackage(
      root,
      { name: "node-pty", version: "1.1.0", license: "MIT" },
      { LICENSE: "node-pty license", NOTICE: "node-pty notice" },
    );
    const packages = collectPackages({
      lists: new Map([
        ["main", ["node_modules/pino"]],
        ["server", ["node_modules/pino", "node_modules/@ai-sdk/provider-utils"]],
      ]),
      packaged: [pty],
      electron: undefined,
      root,
    });
    expect(packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      "@ai-sdk/provider-utils@5.0.0",
      "node-pty@1.1.0",
      "pino@10.0.0",
    ]);
    expect([...packages[2].places]).toEqual(["main", "server"]);
    expect(packages[2].dir).toBe("node_modules/pino");
    expect(pino).toContain(root);

    const text = renderNotices({
      packages,
      components: [
        {
          name: "ONNX Runtime",
          version: "1.28.2",
          license: "MIT",
          source: "https://github.com/microsoft/onnxruntime",
          where: "libonnxruntime",
          texts: ["onnxruntime-LICENSE.txt"],
        },
      ],
      kept: [{ title: "Motion kit drawings", text: "line-md notice\n" }],
    });
    expect(text).toContain(
      "  1. npm packages (3)\n  2. Libraries compiled into sherpa-onnx (1)\n  3. Motion kit drawings\n  4. License texts",
    );
    expect(text).toContain(
      `${"-".repeat(78)}\npino 10.0.0\nLicense: MIT\nSource: https://github.com/pinojs/pino\nShips in: main, server\n\nThe MIT License\nCopyright (c) pino\n`,
    );
    expect(text).not.toContain("not a license");
    expect(text).toContain("[LICENSE]\nnode-pty license\n\n[NOTICE]\nnode-pty notice\n");
    expect(text).toContain(
      'This package ships no license file. Its package.json declares Apache-2.0 and names Vercel as its author; the Apache-2.0 text is under "License texts" below.',
    );
    // Each referenced standard text is appended once, after the kept notices.
    expect(text.match(/^Apache-2\.0\.txt$/gm)).toHaveLength(1);
    expect(text.indexOf("line-md notice")).toBeLessThan(text.indexOf("Apache-2.0.txt\n\n"));
    expect(text).toContain(
      "onnxruntime-LICENSE.txt\n\nMIT License\n\nCopyright (c) Microsoft Corporation",
    );
    expect(text).not.toMatch(/\r/);
  });

  it("asks for native-components.json to be rechecked when sherpa-onnx changes", () => {
    const pinned = JSON.parse(
      readFileSync(new URL("./native-components.json", import.meta.url), "utf8"),
    ).sherpaOnnx;
    expect(readComponents([{ name: "sherpa-onnx-node", version: pinned }]).length).toBeGreaterThan(
      0,
    );
    expect(() => readComponents([{ name: "sherpa-onnx-node", version: "0.0.1" }])).toThrow(
      /recheck the libraries/,
    );
    expect(readComponents([])).toEqual([]);
  });

  it("lists no GPL library: Gram's sherpa-onnx build leaves text-to-speech out", () => {
    const { components } = JSON.parse(
      readFileSync(new URL("./native-components.json", import.meta.url), "utf8"),
    );
    expect(components.filter((component) => /GPL/.test(component.license))).toEqual([]);
    expect(components.map((component) => component.name)).not.toContain("piper-phonemize");
  });

  it("pins the sherpa-onnx the catalog installs", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
      .workspaces.catalog;
    const pinned = JSON.parse(
      readFileSync(new URL("./native-components.json", import.meta.url), "utf8"),
    ).sherpaOnnx;
    expect(pinned).toBe(catalog["sherpa-onnx-node"]);
  });
});
