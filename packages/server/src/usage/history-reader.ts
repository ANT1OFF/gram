import type * as Effect from "effect/Effect";
import type { UsageHistoryCoverage, UsageLocalLimitHistory } from "@gram/contracts";
import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  historyFields,
  makeHistoryReducer,
  type HistoryRecord,
  type HistoryReducer,
} from "./history-records.ts";
import type { UsageHistoryRoot } from "./history-roots.ts";
import { JsonProjection } from "./json-projection.ts";
import {
  isUsageMetadataLine,
  localLimitFields,
  makeLocalLimitCollector,
} from "./local-limit-history.ts";
import { isInside, realPath, realPathOrOwned } from "@gram/git";

export const HISTORY_LIMITS = {
  roots: 8,
  entries: 20_000,
  files: 5_000,
  depth: 5,
  bytes: 268_435_456,
  fileReadBytes: 33_554_432,
  fileBytes: 1_073_741_824,
  lineBytes: 16_777_216,
  records: 50_000,
  metadataBytes: 33_554_432,
  milliseconds: 8_000,
} as const;
export interface HistoryScan {
  readonly to?: number;
  readonly records: readonly HistoryRecord[];
  readonly sources: UsageHistoryCoverage["sources"];
  readonly ambiguous: number;
  readonly localLimitHistory?: UsageLocalLimitHistory;
  readonly provenance?: readonly {
    readonly provider: UsageHistoryRoot["provider"];
    readonly session: string;
    readonly nativeIds: readonly string[];
    readonly complete: boolean;
    readonly fileIdentity?: string;
  }[];
  /** Internal work receipt, never returned by the RPC. */
  readonly work?: {
    readonly bytes: number;
    readonly entries: number;
    readonly files: number;
    readonly metadataBytes: number;
    readonly cacheMetadataBytes: number;
  };
}
export type UsageHistoryInput =
  | HistoryScan
  | ((window: { readonly from: number; readonly to: number }) => Effect.Effect<HistoryScan>);
export const historyMetadataBytes = (scan: HistoryScan) =>
  scan.records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)), 0) +
  (scan.localLimitHistory?.observations ?? []).reduce(
    (bytes, sample) => bytes + Buffer.byteLength(JSON.stringify(sample)),
    0,
  ) +
  (scan.provenance ?? []).reduce(
    (bytes, proof) => bytes + Buffer.byteLength(JSON.stringify(proof)),
    0,
  );
type Source = {
  provider: UsageHistoryRoot["provider"];
  status: "available" | "missing" | "partial";
  files: number;
  skippedFiles: number;
  invalidLines: number;
  skippedLines: number;
};
type Cached = {
  fingerprint: string;
  offset: number;
  discarding: boolean;
  hasher: Hash;
  reducer: HistoryReducer;
  limits: ReturnType<typeof makeLocalLimitCollector>;
  skipped: number;
  invalid: number;
  done: boolean;
  verify?: { fingerprint: string; offset: number; hasher: Hash };
};
type Budget = {
  bytes: number;
  entries: number;
  files: number;
  records: number;
  metadata: number;
  started: number;
  signal: AbortSignal;
};
const fingerprint = (stats: Awaited<ReturnType<typeof lstat>>) =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;

/** Metadata-only in-memory cache. Each refresh re-lists sources; changed prefixes are fully hashed. */
export function makeHistoryReader(
  limits: Readonly<Record<keyof typeof HISTORY_LIMITS, number>> = HISTORY_LIMITS,
) {
  const cache = new Map<string, Cached>();
  let active = false;
  let period: number | undefined;
  const check = (budget: Budget) => {
    budget.signal.throwIfAborted();
    return budget.bytes < limits.bytes && Date.now() - budget.started < limits.milliseconds;
  };
  const readChunk = async (
    handle: FileHandle,
    position: number,
    length: number,
    budget: Budget,
    local: { bytes: number },
  ): Promise<Buffer> => {
    const n = Math.min(
      length,
      65_536,
      limits.bytes - budget.bytes,
      limits.fileReadBytes - local.bytes,
    );
    if (n <= 0 || !check(budget)) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(n);
    const { bytesRead } = await handle.read(buffer, 0, n, position);
    budget.bytes += bytesRead;
    local.bytes += bytesRead;
    return buffer.subarray(0, bytesRead);
  };
  const read = async (
    path: string,
    root: string,
    provider: UsageHistoryRoot["provider"],
    budget: Budget,
    window: { readonly from: number; readonly to: number },
  ): Promise<Cached | undefined> => {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limits.fileBytes)
      return undefined;
    const resolved = await realPath(path);
    if (!isInside(root, resolved)) return undefined;
    let admitted = false;
    const needsRead = (version: string) => {
      const cached = cache.get(resolved);
      return cached === undefined || !cached.done || cached.fingerprint !== version;
    };
    const admitRead = () => {
      if (admitted) return true;
      if (budget.files > limits.files) return false;
      admitted = ++budget.files <= limits.files;
      return admitted;
    };
    // Changed completed entries also need prefix verification. Reject the extra admission
    // before opening it; unchanged completed entries perform no byte reads and remain exempt.
    if (needsRead(fingerprint(before)) && !admitRead()) return undefined;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await handle.stat();
      const afterPath = await realPath(path);
      const pathStats = await lstat(afterPath);
      if (
        !actual.isFile() ||
        actual.dev !== before.dev ||
        actual.ino !== before.ino ||
        actual.dev !== pathStats.dev ||
        actual.ino !== pathStats.ino ||
        !isInside(root, afterPath)
      )
        return undefined;
      const version = fingerprint(actual),
        local = { bytes: 0 };
      // A change between initial stat and the opened handle must not bypass byte-read admission.
      if (needsRead(version) && !admitRead()) return undefined;
      let state = cache.get(resolved);
      if (state !== undefined && state.fingerprint !== version) {
        // A prefix rewritten anywhere (not merely at its tail) must never reuse stale accounting.
        if (actual.size < state.offset) state = undefined;
        else {
          const verification =
            state.verify?.fingerprint === version
              ? state.verify
              : { fingerprint: version, offset: 0, hasher: createHash("sha256") };
          state.verify = verification;
          while (verification.offset < state.offset) {
            const bytes = await readChunk(
              handle,
              verification.offset,
              state.offset - verification.offset,
              budget,
              local,
            );
            if (bytes.length === 0) return undefined;
            verification.hasher.update(bytes);
            verification.offset += bytes.length;
          }
          if (verification.hasher.copy().digest("hex") !== state.hasher.copy().digest("hex"))
            state = undefined;
          else {
            state.fingerprint = version;
            state.hasher = verification.hasher;
            delete state.verify;
            state.done = false;
          }
        }
      }
      state ??= {
        fingerprint: version,
        offset: 0,
        discarding: false,
        hasher: createHash("sha256"),
        reducer: makeHistoryReducer(provider, window.from, window.to),
        limits: makeLocalLimitCollector(),
        skipped: 0,
        invalid: 0,
        done: false,
      };
      cache.set(resolved, state);
      state.reducer.window(window.from, window.to);
      state.limits.window(window.from, window.to);
      if (state.done) return state;
      let position = state.offset,
        lineBytes = 0,
        parser = new JsonProjection(historyFields),
        quotaParser = provider === "codex" ? new JsonProjection(localLimitFields) : undefined,
        decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let lineStart = position,
        lineHasher = state.hasher.copy();
      while (position < actual.size) {
        const chunk = await readChunk(handle, position, actual.size - position, budget, local);
        if (chunk.length === 0) break;
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start),
            end = newline === -1 ? chunk.length : newline + 1;
          const bytes = chunk.subarray(start, end);
          lineBytes += bytes.length;
          lineHasher.update(bytes);
          if (lineBytes > limits.lineBytes && !state.discarding) {
            state.discarding = true;
            state.invalid++;
            state.reducer.breakContext();
          }
          if (!state.discarding) {
            try {
              const decoded = decoder.decode(newline === -1 ? bytes : bytes.subarray(0, -1), {
                stream: true,
              });
              parser.feed(decoded);
              quotaParser?.feed(decoded);
              if (newline !== -1) {
                const tail = decoder.decode();
                parser.feed(tail);
                quotaParser?.feed(tail);
              }
            } catch {
              state.discarding = true;
              state.invalid++;
              state.reducer.breakContext();
            }
          }
          if (newline !== -1) {
            if (!state.discarding) {
              const value = parser.finish();
              if (value === undefined) {
                state.invalid++;
                state.reducer.breakContext();
              } else {
                if (!isUsageMetadataLine(provider, value)) state.skipped++;
                state.reducer.consume(value);
                if (quotaParser !== undefined) {
                  const quota = quotaParser.finish();
                  if (quota === undefined)
                    state.limits.invalidProjection(value, window.from, window.to);
                  else state.limits.consume(quota, window.from, window.to);
                }
              }
            }
            state.offset = position + end;
            state.hasher = lineHasher.copy();
            state.discarding = false;
            lineStart = state.offset;
            lineBytes = 0;
            parser = new JsonProjection(historyFields);
            quotaParser = provider === "codex" ? new JsonProjection(localLimitFields) : undefined;
            decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
            if (state.reducer.records.size > limits.records) {
              cache.delete(resolved);
              return undefined;
            }
          }
          start = end;
        }
        position += chunk.length;
      }
      // Retain a position inside an oversized discarded line; refresh can make bounded progress.
      if (state.discarding) {
        state.offset = position;
        state.hasher = lineHasher.copy();
      }
      state.done = position === actual.size && lineStart === position;
      const final = await handle.stat();
      if (fingerprint(final) !== version) {
        cache.delete(resolved);
        return undefined;
      }
      return state;
    } finally {
      await handle.close();
    }
  };

  return {
    async scan(
      roots: readonly UsageHistoryRoot[],
      signal: AbortSignal,
      window = { from: -Infinity, to: Infinity },
    ): Promise<HistoryScan> {
      // The handler serializes scans. Refuse misuse rather than racing mutable reducer state.
      if (active) throw new Error("Usage history scan already active");
      active = true;
      if (period !== window.to - window.from) cache.clear();
      period = window.to - window.from;
      const budget: Budget = {
        bytes: 0,
        entries: 0,
        files: 0,
        records: 0,
        metadata: 0,
        started: Date.now(),
        signal,
      };
      const sources: Source[] = [],
        records: HistoryRecord[] = [],
        seenRoots = new Set<string>(),
        visited = new Set<string>();
      let ambiguous = 0;
      const localLimits = makeLocalLimitCollector();
      const provenance: NonNullable<HistoryScan["provenance"]>[number][] = [];
      try {
        for (const sourceRoot of roots.slice(0, limits.roots)) {
          const source: Source = {
            provider: sourceRoot.provider,
            status: "available",
            files: 0,
            skippedFiles: 0,
            invalidLines: 0,
            skippedLines: 0,
          };
          let root: string;
          if (sourceRoot.unresolved === true) {
            source.status = "partial";
            sources.push(source);
            continue;
          }
          try {
            const stat = await lstat(sourceRoot.dir);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
              source.status = "partial";
              sources.push(source);
              continue;
            }
            root = await realPath(sourceRoot.dir);
            const key = `${sourceRoot.provider}:${stat.dev}:${stat.ino}`;
            if (seenRoots.has(key)) continue;
            seenRoots.add(key);
          } catch (error) {
            source.status =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
                ? "missing"
                : "partial";
            sources.push(source);
            continue;
          }
          const walk = async (dir: string, depth: number): Promise<void> => {
            if (!check(budget)) {
              source.status = "partial";
              return;
            }
            const resolved = await realPath(dir);
            if (!isInside(root, resolved)) {
              source.status = "partial";
              return;
            }
            const listing = await opendir(dir);
            for await (const entry of listing) {
              if (++budget.entries > limits.entries || !check(budget)) {
                source.status = "partial";
                break;
              }
              const path = join(dir, entry.name);
              if (entry.isSymbolicLink()) {
                source.skippedFiles++;
                source.status = "partial";
                continue;
              }
              if (entry.isDirectory()) {
                if (entry.name === "subagents" || entry.name === "memory") continue;
                if (depth >= limits.depth) {
                  source.status = "partial";
                  continue;
                }
                await walk(path, depth + 1).catch(() => {
                  source.status = "partial";
                });
              } else if (entry.isFile() && /\.jsonl\.(?:zst|gz)$/.test(entry.name)) {
                source.skippedFiles++;
                source.status = "partial";
              } else if (
                entry.isFile() &&
                entry.name.endsWith(".jsonl") &&
                !entry.name.startsWith(".") &&
                entry.name !== "auth.jsonl" &&
                (sourceRoot.provider === "claude" || entry.name.startsWith("rollout-"))
              ) {
                if (budget.records >= limits.records || budget.metadata >= limits.metadataBytes) {
                  source.status = "partial";
                  break;
                }
                visited.add(await realPathOrOwned(path));
                const parsed = await read(path, root, sourceRoot.provider, budget, window).catch(
                  (error: unknown) => {
                    signal.throwIfAborted();
                    void error;
                    return undefined;
                  },
                );
                if (parsed === undefined && budget.files > limits.files) {
                  source.status = "partial";
                  break;
                }
                if (parsed === undefined) {
                  source.skippedFiles++;
                  source.status = "partial";
                  continue;
                }
                source.files++;
                source.invalidLines += parsed.invalid + parsed.reducer.invalid;
                source.skippedLines += parsed.skipped;
                ambiguous += parsed.reducer.ambiguous;
                const limitBytes = parsed.limits.retainedBytes();
                if (budget.metadata + limitBytes > limits.metadataBytes) {
                  source.status = "partial";
                  localLimits.merge({ observations: [], invalidReadings: 0, truncated: true });
                  break;
                }
                budget.metadata += limitBytes;
                localLimits.merge(parsed.limits.snapshot());
                if (
                  !parsed.done ||
                  source.invalidLines > 0 ||
                  parsed.reducer.ambiguous > 0 ||
                  parsed.reducer.nativeOverflow ||
                  !parsed.reducer.identityComplete
                )
                  source.status = "partial";
                const fileIdentity = createHash("sha256")
                  .update(parsed.fingerprint.split(":").slice(0, 2).join(":"))
                  .digest("hex");
                if (parsed.reducer.owner !== undefined) {
                  const proof = {
                    provider: sourceRoot.provider,
                    session: parsed.reducer.owner,
                    fileIdentity,
                    nativeIds: [...parsed.reducer.nativeTurnIds],
                    complete:
                      parsed.done &&
                      parsed.invalid === 0 &&
                      parsed.reducer.invalid === 0 &&
                      !parsed.reducer.nativeOverflow &&
                      parsed.reducer.identityComplete,
                  };
                  const bytes = Buffer.byteLength(JSON.stringify(proof));
                  if (budget.metadata + bytes > limits.metadataBytes) {
                    source.status = "partial";
                    break;
                  }
                  budget.metadata += bytes;
                  provenance.push(proof);
                }
                for (const record of parsed.reducer.records.values()) {
                  const bytes = Buffer.byteLength(JSON.stringify(record));
                  if (
                    budget.records >= limits.records ||
                    budget.metadata + bytes > limits.metadataBytes
                  ) {
                    source.status = "partial";
                    break;
                  }
                  budget.records++;
                  budget.metadata += bytes;
                  records.push({
                    ...structuredClone(record),
                    fileIdentity,
                    complete:
                      record.complete &&
                      parsed.done &&
                      parsed.invalid === 0 &&
                      parsed.reducer.invalid === 0,
                  });
                }
              }
            }
          };
          await walk(root, 0).catch(() => {
            signal.throwIfAborted();
            source.status = "partial";
          });
          sources.push(source);
        }
        if (roots.length > limits.roots && sources[0] !== undefined) sources[0].status = "partial";
        // Deleted/retained sources disappear on refresh; no stale history is returned from cache.
        for (const path of cache.keys()) if (!visited.has(path)) cache.delete(path);
        // Cache admission is independent of response admission; retain at most bounded metadata.
        let cacheBytes = 0,
          cacheRecords = 0;
        for (const [path, entry] of cache) {
          let entryBytes = entry.reducer.retainedBytes() + entry.limits.retainedBytes();
          for (const record of entry.reducer.records.values())
            entryBytes += Buffer.byteLength(JSON.stringify(record));
          entryBytes += [...entry.reducer.nativeTurnIds].reduce(
            (n, id) => n + Buffer.byteLength(id) + 8,
            0,
          );
          if (
            cacheBytes + entryBytes > limits.metadataBytes ||
            cacheRecords + entry.reducer.records.size > limits.records
          )
            cache.delete(path);
          else {
            cacheBytes += entryBytes;
            cacheRecords += entry.reducer.records.size;
          }
        }
        return {
          records,
          sources,
          ambiguous,
          provenance,
          ...(roots.some((root) => root.provider === "codex")
            ? { localLimitHistory: localLimits.snapshot() }
            : {}),
          work: {
            bytes: budget.bytes,
            entries: budget.entries,
            files: budget.files,
            metadataBytes: budget.metadata,
            cacheMetadataBytes: cacheBytes,
          },
          ...(Number.isFinite(window.to) ? { to: window.to } : {}),
        };
      } catch (error) {
        cache.clear();
        throw error;
      } finally {
        active = false;
      }
    },
  };
}
