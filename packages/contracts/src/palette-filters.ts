import * as Schema from "effect/Schema";

/** Closed vocabulary: a helper can propose filters, never commands or destinations. */
export const PALETTE_KINDS = ["thread", "worker", "pr", "ask"] as const;
export const PALETTE_STATES = [
  "failing",
  "waiting",
  "working",
  "idle",
  "done",
  "open",
  "closed",
  "merged",
] as const;
export const PALETTE_TIMES = ["today", "yesterday", "thisWeek", "last24h", "last7d"] as const;
export const PaletteFilter = Schema.Union([
  Schema.Struct({ field: Schema.Literal("workspace"), value: Schema.String }),
  Schema.Struct({ field: Schema.Literal("kind"), value: Schema.Literals(PALETTE_KINDS) }),
  Schema.Struct({ field: Schema.Literal("state"), value: Schema.Literals(PALETTE_STATES) }),
  Schema.Struct({ field: Schema.Literal("time"), value: Schema.Literals(PALETTE_TIMES) }),
]);
export type PaletteFilter = typeof PaletteFilter.Type;
export const PaletteFilterProposal = Schema.Struct({ filters: Schema.Array(PaletteFilter) });

/** Drop unknown workspaces and repeated fields, including proposals from older servers. */
export const validPaletteFilters = (
  filters: readonly PaletteFilter[],
  workspaceIds: readonly string[],
): PaletteFilter[] => {
  const fields = new Set<string>();
  return filters.filter((filter) => {
    const valid =
      filter.field === "workspace"
        ? workspaceIds.includes(filter.value)
        : filter.field === "kind"
          ? PALETTE_KINDS.includes(filter.value)
          : filter.field === "state"
            ? PALETTE_STATES.includes(filter.value)
            : filter.field === "time" && PALETTE_TIMES.includes(filter.value);
    if (!valid || fields.has(filter.field)) return false;
    fields.add(filter.field);
    return true;
  });
};
