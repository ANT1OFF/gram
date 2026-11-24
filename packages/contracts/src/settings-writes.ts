import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { Project } from "./domain.ts";
import { Settings } from "./settings.ts";
import { OrchestratorCharter } from "./workspaces.ts";

/**
 * One stored field a proposal writes, with its value as stored before (`undefined` when absent)
 * and after (`undefined` clears it). `path` is where it is stored: a settings group and field
 * (`["appearance", "mode"]`), a top-level setting (`["logLevel"]`), a charter field
 * (`["maxConcurrentWorkers"]`).
 */
export interface SettingsWrite {
  readonly key: string;
  readonly path: ReadonlyArray<string>;
  readonly before: unknown;
  readonly after: unknown;
}

/** An app setting a workspace write depends on, with the value the card was drawn from. */
export interface SettingsRequirement {
  readonly key: string;
  readonly path: ReadonlyArray<string>;
  readonly value: unknown;
}

/** Whether every app setting `requires` names still holds the value the card showed. */
export const settingsHold = (
  settings: Settings,
  requires: ReadonlyArray<SettingsRequirement>,
): boolean => requires.every((each) => sameValue(storedAt(settings, each.path), each.value));

const canonical = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, each: unknown) =>
    typeof each === "object" && each !== null && !Array.isArray(each)
      ? Object.fromEntries(
          Object.entries(each).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : each,
  );

/** Whether two stored values are the same value, whatever their keys' order. */
export const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

export const storedAt = (root: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((here, step) => (Predicate.isObject(here) ? here[step] : undefined), root);

const withAt = (
  root: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): Record<string, unknown> => {
  const [head, ...rest] = path;
  const next = { ...root };
  if (rest.length === 0) {
    if (value === undefined) delete next[head!];
    else next[head!] = value;
    return next;
  }
  const inner = next[head!];
  next[head!] = withAt(Predicate.isObject(inner) ? inner : {}, rest, value);
  return next;
};

const applyWrites = <A>(
  root: A,
  writes: ReadonlyArray<SettingsWrite>,
  is: (written: unknown) => written is A,
): A | undefined => {
  if (writes.some((write) => !sameValue(storedAt(root, write.path), write.before))) {
    return undefined;
  }
  const written = writes.reduce<Record<string, unknown>>(
    (stored, write) => withAt(stored, write.path, write.after),
    Predicate.isObject(root) ? root : {},
  );
  return is(written) ? written : undefined;
};

/** App writes applied to the settings as they stand now, or `undefined` if one has moved. */
export const applySettingsWrites = (
  settings: Settings,
  writes: ReadonlyArray<SettingsWrite>,
): Settings | undefined => applyWrites(settings, writes, Schema.is(Settings));

/** Charter writes applied to the charter as it stands now, or `undefined` if one has moved. */
export const applyCharterWrites = (
  charter: OrchestratorCharter,
  writes: ReadonlyArray<SettingsWrite>,
): OrchestratorCharter | undefined => applyWrites(charter, writes, Schema.is(OrchestratorCharter));

/** Apply only the approved project fields while their before values still match. */
export const applyProjectSettingsWrites = (
  project: Project,
  writes: ReadonlyArray<SettingsWrite>,
): Project | undefined => applyWrites(project, writes, Schema.is(Project));
