import type { ApprovalScope } from "@gram/contracts";
import * as Predicate from "effect/Predicate";

/** An elicitation as either agent hands it over. */
export interface McpPrompt {
  readonly serverName: string;
  readonly message: string;
  /** `form` and its spellings carry `requestedSchema`; any other mode can't be a card. */
  readonly mode: string;
  readonly requestedSchema?: unknown;
  /** The request's `_meta`, where the agent passes it on. */
  readonly meta?: unknown;
  /**
   * Whether the agent keeps a grant for the session itself when told to (`_meta.persist`). Where
   * it doesn't, the adapter remembers it, and the card offers the session whatever the prompt says.
   */
  readonly adapterRemembers?: boolean;
}

/** The answer to a prompt, before an adapter spells it for its agent. */
export interface McpPromptAnswer {
  readonly action: "accept" | "decline";
  readonly content?: Record<string, string | number | boolean>;
  /** How long an accepted grant lasts beyond this one use. */
  readonly persist?: Exclude<ApprovalScope, "once">;
}

const DECLINE: McpPromptAnswer = { action: "decline" };

const record = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) ? value : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const lifetimeOf = (word: string): Exclude<ApprovalScope, "once"> | undefined => {
  const lower = word.toLowerCase();
  if (lower.includes("session")) return "session";
  return /always|permanent|forever|persistent/.test(lower) ? "always" : undefined;
};

const ONCE = /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i;

interface Field {
  readonly key: string;
  readonly type: string | undefined;
  readonly options: ReadonlyArray<string>;
  readonly default: unknown;
  readonly remembers: boolean;
}

interface Form {
  readonly fields: ReadonlyArray<Field>;
  readonly required: ReadonlyArray<string>;
}

const formOf = (prompt: McpPrompt): Form | undefined => {
  if (prompt.mode !== "form" && prompt.mode !== "openai/form" && prompt.mode !== "openaiForm")
    return undefined;
  const schema = prompt.requestedSchema === undefined ? {} : record(prompt.requestedSchema);
  if (schema === undefined) return undefined;
  const properties = record(schema["properties"]) ?? {};
  const fields = Object.entries(properties).flatMap(([key, value]): Array<Field> => {
    const field = record(value);
    if (field === undefined) return [];
    const oneOf = Array.isArray(field["oneOf"]) ? field["oneOf"] : undefined;
    const options =
      oneOf !== undefined
        ? oneOf.flatMap((option) => text(record(option)?.["const"]) ?? [])
        : Array.isArray(field["enum"])
          ? field["enum"].filter((option): option is string => typeof option === "string")
          : [];
    const type = text(field["type"]);
    return [
      {
        key,
        type,
        options,
        default: field["default"],
        remembers:
          type === "boolean" &&
          [key, text(field["title"]) ?? "", text(field["description"]) ?? ""].some(
            (word) => word.toLowerCase() === "persist" || lifetimeOf(word) !== undefined,
          ),
      },
    ];
  });
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter((key): key is string => typeof key === "string")
    : [];
  return { fields, required };
};

const metaLifetimes = (prompt: McpPrompt): ReadonlySet<ApprovalScope> => {
  const meta = record(prompt.meta);
  const persist = meta?.["persist"];
  const words = typeof persist === "string" ? [persist] : Array.isArray(persist) ? persist : [];
  const found = new Set<ApprovalScope>();
  for (const word of words) {
    const lifetime = typeof word === "string" ? lifetimeOf(word) : undefined;
    if (lifetime !== undefined) found.add(lifetime);
  }
  if (meta?.["allowPersistentApproval"] === true) found.add("always");
  return found;
};

const acceptFor = (prompt: McpPrompt, scope: ApprovalScope): McpPromptAnswer | undefined => {
  const form = formOf(prompt);
  if (form === undefined) return undefined;
  const offered = metaLifetimes(prompt);
  let named =
    scope === "once" ||
    offered.has(scope) ||
    (scope === "session" && prompt.adapterRemembers === true);
  const content: Record<string, string | number | boolean> = {};
  for (const field of form.fields) {
    const chosen = field.options.find((option) =>
      scope === "once"
        ? ONCE.test(option.trim()) && lifetimeOf(option) === undefined
        : lifetimeOf(option) === scope,
    );
    if (chosen !== undefined) {
      content[field.key] = chosen;
      named = true;
    } else if (field.remembers) {
      content[field.key] = scope === "always";
      if (scope === "always") named = true;
    } else if (
      typeof field.default === "string" ||
      typeof field.default === "number" ||
      typeof field.default === "boolean"
    ) {
      content[field.key] = field.default;
    }
  }
  if (!named || form.required.some((key) => !(key in content))) return undefined;
  return { action: "accept", content, ...(scope === "once" ? {} : { persist: scope }) };
};

const SCOPES: ReadonlyArray<ApprovalScope> = ["once", "session", "always"];

/**
 * The lifetimes a card for the prompt may offer, in card order; empty where it can't be a card.
 * Under an outward gate (`gated`) a yes is for the one use only.
 */
export const promptScopes = (prompt: McpPrompt, gated: boolean): Array<ApprovalScope> =>
  acceptFor(prompt, "once") === undefined
    ? []
    : SCOPES.filter(
        (scope) => scope === "once" || (!gated && acceptFor(prompt, scope) !== undefined),
      );

/** The app or site the prompt is about, as the server names it, or `undefined`. */
export const promptSubject = (prompt: McpPrompt): string | undefined => {
  const meta = record(prompt.meta);
  const target = record(meta?.["target"]);
  const params = record(meta?.["tool_params"]);
  return (
    text(meta?.["app_name"]) ??
    text(meta?.["appName"]) ??
    text(meta?.["app"]) ??
    text(target?.["app"]) ??
    text(target?.["name"]) ??
    text(params?.["app_name"]) ??
    text(params?.["app"]) ??
    text(/^Allow (?:ChatGPT|Claude) to use (.+?)\?$/i.exec(prompt.message.trim())?.[1])
  );
};

/** The answer to the prompt: the user's yes for `scope`, or a decline. */
export const promptAnswer = (
  prompt: McpPrompt,
  allow: boolean,
  scope: ApprovalScope,
  gated: boolean,
): McpPromptAnswer => {
  if (!allow) return DECLINE;
  const granted = promptScopes(prompt, gated).includes(scope) ? scope : "once";
  return acceptFor(prompt, granted) ?? DECLINE;
};
