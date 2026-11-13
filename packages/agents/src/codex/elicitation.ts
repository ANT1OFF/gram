// An MCP server's permission prompt (`mcpServer/elicitation/request`) as an approval card: what
// Codex computer use and the ChatGPT browser extension raise before they touch an app or a site
// ("Allow ChatGPT to use Safari?"). Only a prompt that is a yes or no is a card: its form asks
// for nothing but how long the yes lasts. A form with fields of its own, a link to open and a
// user verification are still declined, as before.

import type { ApprovalScope } from "@gram/contracts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { McpServerElicitationRequestResponse } from "./protocol/v2/McpServerElicitationRequestResponse.ts";

export type Elicitation = Extract<
  ServerRequest,
  { method: "mcpServer/elicitation/request" }
>["params"];

/** The answer that turns a prompt down and lets the turn go on. */
export const ELICITATION_DECLINE: McpServerElicitationRequestResponse = {
  action: "decline",
  content: null,
  _meta: null,
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** How long a word for a grant lasts: "session", "always", or neither (once). */
const lifetimeOf = (word: string): Exclude<ApprovalScope, "once"> | undefined => {
  const lower = word.toLowerCase();
  if (lower.includes("session")) return "session";
  return /always|permanent|forever|persistent/.test(lower) ? "always" : undefined;
};

/** A word that grants this one use and no more. */
const ONCE = /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i;

interface Field {
  readonly key: string;
  readonly type: string | undefined;
  /** An enum's values, from `enum` or `oneOf`. */
  readonly options: ReadonlyArray<string>;
  readonly default: unknown;
  /** A boolean that asks whether to remember the grant, by its key, title or description. */
  readonly remembers: boolean;
}

interface Form {
  readonly fields: ReadonlyArray<Field>;
  readonly required: ReadonlyArray<string>;
}

/** The prompt's form, or `undefined` for a mode that has none or a schema that isn't one. */
const formOf = (elicitation: Elicitation): Form | undefined => {
  if (
    elicitation.mode !== "form" &&
    elicitation.mode !== "openai/form" &&
    elicitation.mode !== "openaiForm"
  )
    return undefined;
  const schema = record(elicitation.requestedSchema);
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

/** The lifetimes the prompt's `_meta.persist` names. */
const metaLifetimes = (elicitation: Elicitation): ReadonlySet<ApprovalScope> => {
  const meta = record(elicitation["_meta"]);
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

/**
 * The accepting answer for `scope`, or `undefined` where the prompt can't be accepted that way:
 * it doesn't offer that lifetime, or its form requires a field a yes or no can't fill.
 */
const acceptFor = (
  elicitation: Elicitation,
  scope: ApprovalScope,
): McpServerElicitationRequestResponse | undefined => {
  const form = formOf(elicitation);
  if (form === undefined) return undefined;
  const offered = metaLifetimes(elicitation);
  let named = scope === "once" || offered.has(scope);
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
  return {
    action: "accept",
    content,
    _meta: scope === "once" ? null : { persist: scope },
  };
};

const SCOPES: ReadonlyArray<ApprovalScope> = ["once", "session", "always"];

/**
 * The lifetimes a card for the prompt may offer, in card order; empty where it can't be a card.
 * Under an outward gate (`gated`) a yes is for the one use only.
 */
export const elicitationScopes = (
  elicitation: Elicitation,
  gated: boolean,
): Array<ApprovalScope> =>
  acceptFor(elicitation, "once") === undefined
    ? []
    : SCOPES.filter(
        (scope) => scope === "once" || (!gated && acceptFor(elicitation, scope) !== undefined),
      );

/** The app or site the prompt is about, as the server names it, or `undefined`. */
export const elicitationSubject = (elicitation: Elicitation): string | undefined => {
  const meta = record(elicitation["_meta"]);
  const target = record(meta?.["target"]);
  const params = record(meta?.["tool_params"]);
  const message = "message" in elicitation ? elicitation.message : "";
  return (
    text(meta?.["app_name"]) ??
    text(meta?.["appName"]) ??
    text(meta?.["app"]) ??
    text(target?.["app"]) ??
    text(target?.["name"]) ??
    text(params?.["app_name"]) ??
    text(params?.["app"]) ??
    text(/^Allow ChatGPT to use (.+?)\?$/i.exec(message.trim())?.[1])
  );
};

/** The answer to the prompt: the user's yes for `scope`, or a decline. */
export const elicitationResponse = (
  elicitation: Elicitation,
  allow: boolean,
  scope: ApprovalScope,
  gated: boolean,
): McpServerElicitationRequestResponse => {
  if (!allow) return ELICITATION_DECLINE;
  const offered = elicitationScopes(elicitation, gated);
  // A scope the card didn't offer falls back to the one use, never to a longer grant.
  const granted = offered.includes(scope) ? scope : "once";
  return acceptFor(elicitation, granted) ?? ELICITATION_DECLINE;
};
