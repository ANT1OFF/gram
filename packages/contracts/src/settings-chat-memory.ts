import * as Schema from "effect/Schema";
import {
  AutomaticDreamThreshold,
  MemoryUpdateEveryHours,
  type MemoryUpdateRule,
} from "./workspaces.ts";

/**
 * The settings-chat keys of the two conditions of automatic memory updates
 * (`memoryUpdateRuleOf`): the field of the rule each reads, and what each takes.
 */
export const MEMORY_UPDATE_KEYS = {
  "workspace.automaticDreamThreshold": {
    label: "New items before an automatic memory update",
    rule: "minItems",
    schema: AutomaticDreamThreshold,
    expected: "a whole number from 1 to 1000",
  },
  "workspace.memoryUpdateEveryHours": {
    label: "Hours between automatic memory updates",
    rule: "everyHours",
    schema: MemoryUpdateEveryHours,
    expected: "a whole number of hours from 1 to 168",
  },
} as const satisfies Record<
  string,
  {
    readonly label: string;
    readonly rule: keyof MemoryUpdateRule;
    readonly schema: Schema.Top;
    readonly expected: string;
  }
>;

export type MemoryUpdateKey = keyof typeof MEMORY_UPDATE_KEYS;

/**
 * Writes one condition into a charter being planned, or answers why it can't. Null turns automatic
 * updates off: since either field alone keeps them on, it clears both.
 */
export const setMemoryUpdateCondition = (
  into: Record<string, unknown>,
  key: MemoryUpdateKey,
  value: unknown,
): string | undefined => {
  if (value === null) {
    delete into["automaticDreamThreshold"];
    delete into["memoryUpdateEveryHours"];
    return undefined;
  }
  const { schema, expected } = MEMORY_UPDATE_KEYS[key];
  if (!Schema.is(schema)(value)) return `expected ${expected}, or null for off.`;
  into[key.slice("workspace.".length)] = value;
  return undefined;
};
