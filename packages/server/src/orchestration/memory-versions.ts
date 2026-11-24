import { redactText } from "../logging/redact.ts";
import * as Predicate from "effect/Predicate";

const VERSION = /^\d{4}$/;

/** The memory update a version came from, kept beside it so History can say so. */
export interface MemoryVersionSource {
  readonly dreamId: string;
  readonly mode: "review" | "auto";
  /** Its one line on what it changed. */
  readonly summary?: string | undefined;
}

/** The longest summary a version keeps. */
export const SOURCE_SUMMARY_MAX = 300;

/** A version's `.adopted` note, as far as it can be read; nothing for a hand-edited one. */
export const adoptedNote = (
  text: string,
): { adoptedAt?: number; basedOn?: string; source?: MemoryVersionSource } => {
  try {
    const note = JSON.parse(text) as Record<string, unknown>;
    const out: { adoptedAt?: number; basedOn?: string; source?: MemoryVersionSource } = {};
    if (typeof note["adoptedAt"] === "number" && Number.isFinite(note["adoptedAt"]))
      out.adoptedAt = note["adoptedAt"];
    if (typeof note["basedOn"] === "string" && VERSION.test(note["basedOn"]))
      out.basedOn = note["basedOn"];
    const source = note["source"] as Record<string, unknown> | undefined;
    if (
      Predicate.isObject(source) &&
      typeof source["dreamId"] === "string" &&
      /^[A-Za-z0-9-]{8,64}$/.test(source["dreamId"]) &&
      (source["mode"] === "review" || source["mode"] === "auto")
    ) {
      out.source = {
        dreamId: source["dreamId"],
        mode: source["mode"],
        ...(typeof source["summary"] === "string"
          ? { summary: redactText(source["summary"]).slice(0, SOURCE_SUMMARY_MAX) }
          : {}),
      };
    }
    return out;
  } catch (_handEditedIntoSomethingElse) {
    return {};
  }
};

/** The `.adopted` note a new version is written with: when, what it was made from, and by which run. */
export const adoptionNote = (
  adoptedAt: number,
  basedOn: string | undefined,
  source: MemoryVersionSource | undefined,
) => ({
  adoptedAt,
  ...(basedOn === undefined ? {} : { basedOn }),
  ...(source === undefined
    ? {}
    : {
        source: {
          ...source,
          ...(source.summary === undefined
            ? {}
            : { summary: redactText(source.summary).slice(0, SOURCE_SUMMARY_MAX) }),
        },
      }),
});
