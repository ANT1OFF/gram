import { CUSTOM_MODEL_DESCRIPTION as ADDED_IN_SETTINGS } from "./custom-models.ts";
import type { AgentModel } from "./models.ts";

/** What of a `models.list` row naming a model is read by: its id, the id it runs, its name. */
export type CatalogueRow = Pick<AgentModel, "id" | "displayName" | "resolvedId">;

/**
 * `claude-haiku-5-5` → "Haiku 5.5": the name Claude Code gives the alias row that runs that id,
 * which is how such a row with no `resolvedId` says which model it runs.
 */
export const claudeLabel = (id: string): string | undefined => {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (match === null) return undefined;
  return `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]}`;
};

const LONG = /\[1m\]$/i;
/** A model id without a dated snapshot's suffix; the `[1m]` window is kept, being another row. */
const undated = (id: string) => id.toLowerCase().replace(/-\d{8}(?=\[1m\]$|$)/i, "");
/** A display name as a person types it: no case, no spaces ("Fable 5.2" is "fable5.2"). */
const squashed = (name: string) => name.toLowerCase().replace(/\s+/g, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type ModelResolution<T extends CatalogueRow> =
  | {
      readonly ok: true;
      readonly row: T;
      /**
       * How `name` named it: the row's own id; the pinned model id the row runs (`resolvedId`, or
       * for a Claude alias row without one, the id its name says); or its display name.
       */
      readonly via: "id" | "runs" | "displayName";
    }
  | { readonly ok: false; readonly why: "unknown" | "ambiguous" };

/**
 * `name` as one row of an agent's model catalogue (`models.list`), as the picker lists it. Tried in
 * order, the first that finds any wins:
 *
 * 1. a row's id, ignoring case (`fable`, a CLI alias, or a pinned row's own id);
 * 2. the model id a row runs: its `resolvedId`, or, for a Claude alias row that reports none, the
 *    id its display name says (`Fable 5.2` runs `claude-fable-5-2`), as `findListed` reads it. A
 *    dated snapshot matches its plain id, and a `[1m]` window only a windowed row. This is what the
 *    catalogue says the alias runs today: once `fable` moves to a newer model, its row no longer
 *    runs `claude-fable-5-2`, so that pinned id stops naming it;
 * 3. a display name, ignoring case and spaces (`Fable 5.2`, `fable 5.2`).
 *
 * Several rows running the same model (the CLI's `default` and the alias it follows) are one
 * choice, the named row preferred to `default`; several rows by one name that run different
 * models are ambiguous.
 */
export const resolveModel = <T extends CatalogueRow>(
  models: ReadonlyArray<T> | undefined,
  name: string,
): ModelResolution<T> => {
  const wanted = name.trim();
  if (models === undefined || wanted === "") return { ok: false, why: "unknown" };
  const lower = wanted.toLowerCase();

  const byId = models.filter((row) => row.id.toLowerCase() === lower);
  if (byId.length === 1) return { ok: true, row: byId[0]!, via: "id" };
  if (byId.length > 1) {
    const exact = byId.filter((row) => row.id === wanted);
    return exact.length === 1
      ? { ok: true, row: exact[0]!, via: "id" }
      : { ok: false, why: "ambiguous" };
  }

  const plain = undated(wanted);
  const windowed = LONG.test(wanted);
  const label = claudeLabel(plain.replace(LONG, ""));
  const labelled = label === undefined ? undefined : new RegExp(`^${escape(label)}(?:\\s|$)`, "i");
  const running = models.filter((row) =>
    row.resolvedId !== undefined
      ? undated(row.resolvedId) === plain
      : labelled !== undefined &&
        LONG.test(row.id) === windowed &&
        labelled.test(row.displayName.trim()),
  );
  if (running.length > 0) {
    // "default" follows the CLI's own choice, which may move; a named row stays on this model.
    return {
      ok: true,
      row: running.find((row) => row.id !== "default") ?? running[0]!,
      via: "runs",
    };
  }

  const key = squashed(wanted);
  const byName = models.filter((row) => squashed(row.displayName) === key);
  if (byName.length === 0) return { ok: false, why: "unknown" };
  const first = byName[0]!;
  const runsOf = (row: T) => (row.resolvedId ?? row.id).toLowerCase();
  return byName.every((row) => runsOf(row) === runsOf(first))
    ? { ok: true, row: byName.find((row) => row.id !== "default") ?? first, via: "displayName" }
    : { ok: false, why: "ambiguous" };
};

/** The catalogue row `name` resolves to, if exactly one does. */
export const listedRow = <T extends CatalogueRow>(
  models: ReadonlyArray<T> | undefined,
  name: string | undefined,
): T | undefined => {
  if (name === undefined) return undefined;
  const found = resolveModel(models, name);
  return found.ok ? found.row : undefined;
};

/**
 * The model id to store for `name`, as the picker would: a row's own id for a row named by its
 * id or display name; a pinned model id kept as named (lower-cased, as ids are), never swapped for
 * the alias that runs it today, so it doesn't move when the alias does. `undefined` when the
 * catalogue has no single row for it.
 */
export const canonicalModelId = (
  models: ReadonlyArray<CatalogueRow> | undefined,
  name: string,
): string | undefined => {
  const found = resolveModel(models, name);
  if (!found.ok) return undefined;
  return found.via === "runs" ? name.trim().toLowerCase() : found.row.id;
};

/** Edits from `a` to `b`, a swap of two neighbouring letters counting as one ("fabel", "fable"). */
const distance = (a: string, b: string): number => {
  const rows: Array<Array<number>> = [Array.from({ length: b.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(
        rows[i - 1]![j]! + 1,
        current[j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      }
      current[j] = best;
    }
    rows.push(current);
  }
  return rows[a.length]![b.length]!;
};

/**
 * Of `candidates` (each with the words it may be called by), the one closest to `wanted`, for a
 * refusal's "did you mean": one whose words contain it or it contains, else the fewest edits away
 * within a third of its length. `undefined` when none is near.
 */
export const closestName = <T>(
  candidates: ReadonlyArray<{ readonly value: T; readonly words: ReadonlyArray<string> }>,
  wanted: string,
): T | undefined => {
  const key = squashed(wanted);
  if (key === "") return undefined;
  let best: { value: T; score: number } | undefined;
  for (const candidate of candidates) {
    for (const word of candidate.words) {
      const each = squashed(word);
      if (each === "") continue;
      const score =
        Math.min(each.length, key.length) >= 3 && (each.includes(key) || key.includes(each))
          ? 0
          : distance(each, key) / Math.max(each.length, key.length);
      if (score <= 1 / 3 && (best === undefined || score < best.score)) {
        best = { value: candidate.value, score };
      }
    }
  }
  return best?.value;
};

/** A model's family and version as its name says them: "Opus 5.5" is `opus #` at 5.5. */
interface FamilyVersion {
  readonly family: string;
  readonly version: ReadonlyArray<number>;
}

const VERSION = /\d+(?:\.\d+)*/;

/** `text`'s first version number and the words around it, as one family key; none without one. */
const familyVersionOf = (text: string): FamilyVersion | undefined => {
  const found = VERSION.exec(text);
  if (found === null) return undefined;
  const family = `${text.slice(0, found.index)}#${text.slice(found.index + found[0].length)}`
    .toLowerCase()
    .replace(/[\s\-_]+/g, " ")
    .replace(/^claude /, "")
    .trim();
  return { family, version: found[0].split(".").map(Number) };
};

/**
 * What a row's name says of its family and version: its display name ("Fable 5.2", "GPT-6.1-Sol"),
 * else for a Claude id the name that id has (`claude-opus-5-5` → "Opus 5.5"), else its id
 * (`gpt-6.1-sol`). None when no version is in any of them.
 */
const rowFamily = (row: CatalogueRow): FamilyVersion | undefined => {
  const runs = (row.resolvedId ?? row.id).replace(LONG, "").replace(/-\d{8}$/, "");
  return (
    familyVersionOf(row.displayName) ??
    (claudeLabel(runs) === undefined ? undefined : familyVersionOf(claudeLabel(runs)!)) ??
    familyVersionOf(row.id)
  );
};

const newer = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
};

/**
 * The ids of the catalogue's rows a newer row of the same family supersedes: Opus 5 and Opus 4.6
 * beside Opus 5.5, Fable 5.1 beside Fable 5.2, GPT-6-Sol beside GPT-6.1-Sol. A family is a name
 * with its version taken out ("Opus #", "GPT # Sol", "Opus # (1M context)"), so a variant only
 * gives way to a newer one of itself, and a version is the first number in the name, compared
 * part by part. Never superseded: the CLI's `default` row and its default model, which it chose
 * (the default still supersedes older ones); a model the user added; and a row whose name holds
 * no version, which has nothing reliable to compare by.
 */
export const supersededModels = (
  models: ReadonlyArray<
    CatalogueRow & { readonly isDefault?: boolean | undefined; readonly description?: string }
  >,
): ReadonlySet<string> => {
  // The CLI's `default` follows another row; a model the user added carries their own name.
  const ranked = models.flatMap((row) => {
    if (row.id === "default" || row.description === ADDED_IN_SETTINGS) return [];
    const found = rowFamily(row);
    return found === undefined ? [] : [{ id: row.id, kept: row.isDefault === true, ...found }];
  });
  return new Set(
    ranked
      .filter(
        (row) =>
          !row.kept &&
          ranked.some((other) => other.family === row.family && newer(other.version, row.version)),
      )
      .map((row) => row.id),
  );
};
