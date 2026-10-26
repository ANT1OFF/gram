import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GatewayModel, ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";

/**
 * Codex's model catalog, as `codex debug models --bundled` prints it and `model_catalog_json`
 * reads it. Entries are kept whole and opaque: only `slug`, `display_name`, the effort list and the
 * context fields are ever rewritten, so a field a newer Codex adds survives the clone.
 */
export interface CodexCatalog {
  readonly models: ReadonlyArray<CatalogEntry>;
}

export type CatalogEntry = Readonly<Record<string, unknown>> & { readonly slug: string };

/**
 * Historical context-window override for cloned gateway models. Codex uses this for compaction;
 * it is not evidence of the configured provider's capacity or billing thresholds.
 */
export const GATEWAY_CONTEXT_WINDOW = 272_000;

/**
 * Efforts a clone never carries. `ultra` is Codex's "maximum reasoning with automatic task
 * delegation", and what it puts on the wire through a gateway is unknown.
 */
const DROPPED_EFFORTS: ReadonlySet<string> = new Set(["ultra"]);

/**
 * Historical gateway alias targets retained for configured profiles. These supply catalog
 * metadata only; the actual deployment and routing belong to the user's gateway.
 */
const ALIASES: Readonly<Record<string, string>> = {
  "gpt-latest": "gpt-6.1-sol",
  "gpt-chat-latest": "gpt-6.1-sol",
};

/** The body of `codex debug models --bundled`, or `undefined` when it isn't a catalog. */
export const parseCatalog = (text: string): CodexCatalog | undefined => {
  try {
    const body = JSON.parse(text) as { models?: unknown } | null;
    if (!Array.isArray(body?.models)) return undefined;
    const models = body.models.filter(
      (entry): entry is CatalogEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { slug?: unknown }).slug === "string",
    );
    return models.length === 0 ? undefined : { models };
  } catch {
    return undefined;
  }
};

interface Family {
  readonly prefix: string;
  readonly version: ReadonlyArray<number>;
  readonly tier: string;
}

/** `gpt-6.1-sol` as `gpt`, `[6, 1]`, `sol`; `gpt-5.5` has an empty tier. */
const familyOf = (slug: string): Family | undefined => {
  const match = /^([a-z]+)-(\d+(?:\.\d+)*)(?:-([a-z]+))?$/.exec(slug);
  if (match === null) return undefined;
  return { prefix: match[1]!, version: match[2]!.split(".").map(Number), tier: match[3] ?? "" };
};

const compareVersions = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * The catalog model a gateway model should behave like, for one Codex doesn't know: an alias's
 * target, and otherwise the same family and tier at the nearest version not above it, with the
 * gateway's `-eu` (EU data zone) suffix taken off first. So `gpt-6.1-sol-eu` → `gpt-6-sol`, and
 * `gpt-5.4` → nothing, as the only untiered GPT Codex knows is the later `gpt-5.5`.
 */
export const catalogBase = (slug: string, known: ReadonlySet<string>): string | undefined => {
  const bare = slug.endsWith("-eu") ? slug.slice(0, -"-eu".length) : slug;
  const target = ALIASES[bare] ?? bare;
  if (known.has(target)) return target;
  const family = familyOf(target);
  if (family === undefined) return undefined;
  let best: { readonly slug: string; readonly version: ReadonlyArray<number> } | undefined;
  for (const candidate of known) {
    const other = familyOf(candidate);
    if (other === undefined || other.prefix !== family.prefix || other.tier !== family.tier) {
      continue;
    }
    if (compareVersions(other.version, family.version) > 0) continue;
    if (best === undefined || compareVersions(other.version, best.version) > 0) {
      best = { slug: candidate, version: other.version };
    }
  }
  return best?.slug;
};

const cloneEntry = (base: CatalogEntry, model: GatewayModel): CatalogEntry => {
  const levels = Array.isArray(base["supported_reasoning_levels"])
    ? (base["supported_reasoning_levels"] as ReadonlyArray<{ readonly effort?: unknown }>).filter(
        (level) => typeof level.effort !== "string" || !DROPPED_EFFORTS.has(level.effort),
      )
    : base["supported_reasoning_levels"];
  return {
    // `supports_search_tool` gates MCP discovery/deferral in Codex 0.160.1, so inherit it.
    // The gateway's unsupported web search is disabled separately by `appServerArgs`.
    ...base,
    slug: model.id,
    display_name: model.name,
    supported_reasoning_levels: levels,
    context_window: GATEWAY_CONTEXT_WINDOW,
  };
};

/**
 * `bundled` plus a clone for each gateway model Codex doesn't know but whose `catalogBase` it does,
 * or `undefined` when there is none to add, so Codex keeps its own catalog. Codex replaces its
 * catalog with the file rather than merging, which is why the bundled entries go in whole.
 */
export const gatewayCatalog = (
  bundled: CodexCatalog,
  models: ReadonlyArray<GatewayModel>,
): CodexCatalog | undefined => {
  const bySlug = new Map(bundled.models.map((entry) => [entry.slug, entry]));
  const known = new Set(bySlug.keys());
  const clones: Array<CatalogEntry> = [];
  for (const model of models) {
    if (known.has(model.id)) continue;
    const base = catalogBase(model.id, known);
    if (base === undefined) continue;
    clones.push(cloneEntry(bySlug.get(base)!, model));
  }
  return clones.length === 0 ? undefined : { models: [...bundled.models, ...clones] };
};

/** The directory under Gram's Codex home that holds one catalog per gateway profile. */
export const CATALOG_DIR = "gram-models";

/**
 * Writes `catalog` for `profileId` under the gateway home (0600, in a 0700 directory) and returns
 * its path, for `model_catalog_json`. The profile id is encoded, as it names a file.
 */
export const writeCatalog = (
  home: string,
  profileId: ProfileId,
  catalog: CodexCatalog,
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const dir = join(home, CATALOG_DIR);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const file = join(dir, `${encodeURIComponent(profileId)}.json`);
      await writeFile(file, JSON.stringify(catalog), { mode: 0o600 });
      await chmod(file, 0o600);
      return file;
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
