import { macFs, macFsPromises } from "./mac-fs.ts";
import { createHash } from "node:crypto";

import { join, relative, sep } from "node:path";

import { MAX_BUNDLE_BYTES, MAX_ENTRIES, safeLink, safeRelative } from "./mac-archive.ts";

export const MAC_MANIFESTS = [
  "BUILD-INFO.json",
  "BUNDLE-INVENTORY.json",
  "BUNDLE-SHA256SUMS.txt",
  "WEB-SHA256SUMS.txt",
] as const;

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function boundedText(path: string, max = 4 * 1024 ** 2): Promise<string> {
  // Bind type and byte limit to the opened file, not a prior path stat. Read at most max + 1
  // bytes even if its content grows; the caller never allocates an unbounded readFile buffer.
  const file = await open(path, macFs.constants.O_RDONLY | macFs.constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.size > max) throw new Error("Unsafe or oversized update manifest");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > max) throw new Error("Unsafe or oversized update manifest");
    return buffer.toString("utf8", 0, size);
  } finally {
    await file.close();
  }
}

export function checksumMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !safeRelative(match[2]!) || map.has(match[2]!))
      throw new Error("Invalid checksum manifest");
    map.set(match[2]!, match[1]!);
  }
  return map;
}

function plistString(text: string, key: string): string {
  const matches = [
    ...text.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g")),
  ];
  if (matches.length !== 1) throw new Error(`Invalid bundle ${key}`);
  return matches[0]![1]!;
}

export async function verifyBundleIdentity(bundle: string, version: string): Promise<void> {
  const plist = await boundedText(join(bundle, "Contents/Info.plist"), 128 * 1024);
  if (
    plistString(plist, "CFBundleIdentifier") !== "io.github.ant1off.gram" ||
    plistString(plist, "CFBundleExecutable") !== "Gram" ||
    plistString(plist, "CFBundleShortVersionString") !== version ||
    plistString(plist, "CFBundleVersion") !== version
  )
    throw new Error("Unexpected Gram bundle identity/version");
  const main = await open(join(bundle, "Contents/MacOS/Gram"), "r");
  try {
    const head = Buffer.alloc(8);
    await main.read(head, 0, 8, 0);
    if (
      head.readUInt32LE(0) !== 0xfeedfacf ||
      head.readUInt32LE(4) !== 0x0100000c ||
      ((await main.stat()).mode & 0o111) === 0
    )
      throw new Error("Expected an executable arm64 Gram bundle");
  } finally {
    await main.close();
  }
  const asar = await open(join(bundle, "Contents/Resources/app.asar"), "r");
  try {
    const head = Buffer.alloc(16);
    await asar.read(head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4),
      jsonSize = head.readUInt32LE(12);
    if (headerSize > 8 * 1024 ** 2 || jsonSize > headerSize - 8)
      throw new Error("Invalid app.asar header");
    const json = Buffer.alloc(jsonSize);
    await asar.read(json, 0, jsonSize, 16);
    const info = JSON.parse(json.toString("utf8")).files?.["package.json"] as
      | { size?: number; offset?: string; unpacked?: boolean }
      | undefined;
    const offset = Number(info?.offset);
    if (
      !info ||
      info.unpacked ||
      !Number.isSafeInteger(info.size) ||
      info.size! < 1 ||
      info.size! > 65536 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + info.size! + 8 + headerSize > (await asar.stat()).size
    )
      throw new Error("Invalid packaged app metadata");
    const data = Buffer.alloc(info.size!);
    await asar.read(data, 0, data.length, 8 + headerSize + offset);
    const pkg = JSON.parse(data.toString("utf8"));
    if (pkg.name !== "@gram/desktop" || pkg.productName !== "Gram" || pkg.version !== version)
      throw new Error("Unexpected packaged Gram product/version");
  } finally {
    await asar.close();
  }
}

export function validateMacBuildMethod(
  build: Record<string, unknown>,
  policy: MacBundlePolicy,
): void {
  // An unsigned build is a private RC, cut only from a private repository; a signed release may
  // come from the public one.
  if (policy.method === "unsigned-private-helper") {
    if (
      build.developerIdSigned !== false ||
      build.notarized !== false ||
      build.repositoryPrivate !== true
    )
      throw new Error("Unexpected private unsigned build metadata");
    return;
  }
  if (
    policy.method !== "signed-native-macos-v1" ||
    typeof build.repositoryPrivate !== "boolean" ||
    !/^[A-Z0-9]{10}$/.test(policy.teamId) ||
    !/^[a-f0-9]{64}$/.test(policy.requirementSha256) ||
    build.schema !== "gram.signed-build/v1" ||
    build.method !== policy.method ||
    build.developerIdSigned !== true ||
    build.notarized !== true ||
    build.stapled !== true ||
    build.teamId !== policy.teamId ||
    build.bundleId !== "io.github.ant1off.gram" ||
    build.requirementSha256 !== policy.requirementSha256 ||
    build.notarizationStatus !== "accepted"
  )
    throw new Error("Unexpected signed build metadata or missing publisher policy");
}

/** `verifyMacBundleForMethod` for an unsigned build, whose unsigned metadata is mandatory. */
export async function verifyMacBundle(
  bundle: string,
  manifests: string,
  version: string,
  sourceCommit: string,
): Promise<void> {
  return verifyMacBundleForMethod(bundle, manifests, version, sourceCommit, {
    method: "unsigned-private-helper",
  });
}
export type MacBundlePolicy =
  | { readonly method: "unsigned-private-helper" }
  | {
      readonly method: "signed-native-macos-v1";
      readonly teamId: string;
      readonly requirementSha256: string;
    };

/** Inventory and hashes cover the whole bundle, including web resources outside ASAR. */
export async function verifyMacBundleForMethod(
  bundle: string,
  manifests: string,
  version: string,
  sourceCommit: string,
  policy: MacBundlePolicy,
): Promise<void> {
  const rootStat = await lstat(bundle);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Expected a regular app bundle directory");
  bundle = await realpath(bundle);
  const build = JSON.parse(await boundedText(join(manifests, "BUILD-INFO.json")));
  if (
    build.version !== version ||
    build.tag !== `v${version}` ||
    build.repository !== "ANT1OFF/gram" ||
    build.platform !== "darwin-arm64" ||
    build.sourceCommit !== sourceCommit
  )
    throw new Error("Unexpected build metadata");
  validateMacBuildMethod(build, policy);
  for (const [file, field] of [
    ["BUNDLE-SHA256SUMS.txt", "bundleChecksumManifestSha256"],
    ["WEB-SHA256SUMS.txt", "webChecksumManifestSha256"],
    ["BUNDLE-INVENTORY.json", "bundleInventorySha256"],
  ] as const) {
    if ((await sha256(join(manifests, file))) !== build[field])
      throw new Error("Build manifest SHA-256 mismatch");
  }
  const sums = checksumMap(await boundedText(join(manifests, "BUNDLE-SHA256SUMS.txt")));
  const web = checksumMap(await boundedText(join(manifests, "WEB-SHA256SUMS.txt")));
  const inventory: unknown = JSON.parse(
    await boundedText(join(manifests, "BUNDLE-INVENTORY.json")),
  );
  if (!Array.isArray(inventory) || inventory.length > MAX_ENTRIES)
    throw new Error("Invalid bundle inventory");
  const records = new Map<
    string,
    { type: string; mode: string; target?: string; bytes?: number }
  >();
  const folded = new Set<string>();
  for (const item of inventory) {
    const path: unknown = item?.path;
    if (
      typeof path !== "string" ||
      !safeRelative(path) ||
      folded.has(path.normalize("NFD").toLowerCase()) ||
      !["file", "directory", "symlink"].includes(item.type) ||
      !/^0o[0-7]{3}$/.test(item.mode)
    )
      throw new Error("Unsafe bundle inventory");
    folded.add(path.normalize("NFD").toLowerCase());
    records.set(path, item);
  }
  let count = 0,
    bytes = 0;
  const seen = new Set<string>();
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const path = join(dir, name),
        rel = relative(bundle, path).split(sep).join("/");
      if (++count > MAX_ENTRIES) throw new Error("Bundle entry limit exceeded");
      const expected = records.get(rel),
        stat = await lstat(path);
      if (!expected || !safeRelative(rel)) throw new Error("Unexpected bundle entry");
      seen.add(rel);
      if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = await realpath(path);
        if (
          expected.type !== "symlink" ||
          (stat.mode & 0o777) !== parseInt(expected.mode.slice(2), 8) ||
          target !== expected.target ||
          !safeLink(rel, target) ||
          !resolved.startsWith(`${bundle}${sep}`)
        )
          throw new Error("Unsafe or changed bundle symlink");
      } else {
        if ((stat.mode & 0o7777) !== parseInt(expected.mode.slice(2), 8))
          throw new Error("Bundle mode mismatch");
        if (stat.isDirectory() && expected.type === "directory") await walk(path);
        else if (stat.isFile() && expected.type === "file") {
          bytes += stat.size;
          if (
            bytes > MAX_BUNDLE_BYTES ||
            stat.size !== expected.bytes ||
            !sums.has(rel) ||
            (await sha256(path)) !== sums.get(rel)
          )
            throw new Error("Bundle SHA-256/size mismatch");
          if (rel.startsWith("Contents/Resources/web/") && web.get(rel) !== sums.get(rel))
            throw new Error("Web manifest mismatch");
          // Refuse any foreign Mach-O native, not just the main executable.
          const file = await open(path, "r");
          try {
            const head = Buffer.alloc(8);
            const { bytesRead } = await file.read(head, 0, 8, 0);
            if (
              bytesRead >= 4 &&
              [0xfeedfacf, 0xfeedface, 0xcefaedfe, 0xcffaedfe, 0xbebafeca, 0xcafebabe].includes(
                head.readUInt32LE(0),
              ) &&
              (head.readUInt32LE(0) !== 0xfeedfacf || head.readUInt32LE(4) !== 0x0100000c)
            )
              throw new Error("Unexpected native executable architecture");
          } finally {
            await file.close();
          }
        } else throw new Error("Unexpected bundle file type");
      }
    }
  }
  await walk(bundle);
  if (
    seen.size !== records.size ||
    sums.size !== inventory.filter((i) => i.type === "file").length ||
    [...sums.keys()].some((p) => records.get(p)?.type !== "file") ||
    [...web.keys()].some(
      (p) => !p.startsWith("Contents/Resources/web/") || sums.get(p) !== web.get(p),
    )
  )
    throw new Error("Incomplete bundle manifest");
  await verifyBundleIdentity(bundle, version);
}

const { createReadStream } = macFs;
const { lstat, open, readdir, readlink, realpath } = macFsPromises;
