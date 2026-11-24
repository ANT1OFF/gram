/** The OpenCode release this adapter was written against and recorded with. */
export const OPENCODE_CLI_VERSION = "2.3.0";

export interface OpenCodeTokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

export interface OpenCodeError {
  readonly type: string;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export interface OpenCodeModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** A tool result's content: text, or a file it points at. */
export type OpenCodeContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string };

/** One event of `GET /api/event` (server-sent events, one JSON object per `data:` line). */
export interface OpenCodeEvent {
  readonly id?: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A permission request (`permission.asked`, and `GET /api/session/{id}/permission`). */
export interface OpenCodePermission {
  readonly id: string;
  readonly sessionID: string;
  /** `shell`, `edit`, `read`, `webfetch`, `<server>_<tool>` for MCP, … */
  readonly action: string;
  /** What it acts on: the command for `shell`, paths for file actions. */
  readonly resources: ReadonlyArray<string>;
  /** The patterns an `always` reply saves. */
  readonly save?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly source?: { readonly type: "tool"; readonly messageID: string; readonly id: string };
  readonly message?: string;
}

/** How a permission is answered (`POST /api/session/{id}/permission/{request}/reply`). */
export type OpenCodePermissionReply = "once" | "always" | "reject";

/** A permission rule: the last that matches wins, and no match asks. */
export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

/** A model as `GET /api/model` lists it. */
export interface OpenCodeModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly capabilities?: { readonly tools?: boolean };
  readonly variants?: ReadonlyArray<{ readonly id: string }>;
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly status?: string;
  readonly enabled?: boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One `data:` payload as an event, or `undefined` when it isn't one. */
export const parseEvent = (text: string): OpenCodeEvent | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value["type"] !== "string") return undefined;
  const data = isRecord(value["data"]) ? value["data"] : {};
  return {
    type: value["type"],
    data,
    ...(typeof value["id"] === "string" ? { id: value["id"] } : {}),
  };
};

/** Field readers for an event's `data`, which tolerate what a newer OpenCode adds or drops. */
export const field = {
  string: (data: Readonly<Record<string, unknown>>, key: string): string | undefined => {
    const value = data[key];
    return typeof value === "string" ? value : undefined;
  },
  number: (data: Readonly<Record<string, unknown>>, key: string): number | undefined => {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  },
  record: (
    data: Readonly<Record<string, unknown>>,
    key: string,
  ): Readonly<Record<string, unknown>> | undefined => {
    const value = data[key];
    return isRecord(value) ? value : undefined;
  },
  array: (data: Readonly<Record<string, unknown>>, key: string): ReadonlyArray<unknown> => {
    const value = data[key];
    return Array.isArray(value) ? value : [];
  },
};

export const tokensOf = (value: unknown): OpenCodeTokens | undefined => {
  if (!isRecord(value)) return undefined;
  const number = (key: string, from: Readonly<Record<string, unknown>> = value) =>
    typeof from[key] === "number" ? from[key] : 0;
  const cache = isRecord(value["cache"]) ? value["cache"] : {};
  return {
    input: number("input"),
    output: number("output"),
    reasoning: number("reasoning"),
    cache: { read: number("read", cache), write: number("write", cache) },
  };
};

export const errorOf = (value: unknown): OpenCodeError | undefined => {
  if (!isRecord(value) || typeof value["message"] !== "string") return undefined;
  return {
    type: typeof value["type"] === "string" ? value["type"] : "unknown",
    message: value["message"],
    ...(typeof value["status"] === "number" ? { status: value["status"] } : {}),
    ...(typeof value["retryAfterMs"] === "number" ? { retryAfterMs: value["retryAfterMs"] } : {}),
  };
};

export const permissionOf = (value: unknown): OpenCodePermission | undefined => {
  if (!isRecord(value)) return undefined;
  const { id, sessionID, action } = value;
  if (typeof id !== "string" || typeof sessionID !== "string" || typeof action !== "string")
    return undefined;
  const strings = (key: string) =>
    Array.isArray(value[key])
      ? (value[key] as ReadonlyArray<unknown>).filter((each) => typeof each === "string")
      : undefined;
  const source = isRecord(value["source"]) ? value["source"] : undefined;
  const save = strings("save");
  return {
    id,
    sessionID,
    action,
    resources: strings("resources") ?? [],
    ...(save === undefined ? {} : { save }),
    ...(isRecord(value["metadata"]) ? { metadata: value["metadata"] } : {}),
    ...(source !== undefined &&
    typeof source["messageID"] === "string" &&
    typeof source["id"] === "string"
      ? { source: { type: "tool" as const, messageID: source["messageID"], id: source["id"] } }
      : {}),
    ...(typeof value["message"] === "string" ? { message: value["message"] } : {}),
  };
};

/** A tool result's text: its text parts joined, and each file part named. */
export const contentText = (value: unknown): string => {
  if (!Array.isArray(value)) return "";
  return value
    .map((part: unknown) => {
      if (!isRecord(part)) return "";
      if (part["type"] === "text" && typeof part["text"] === "string") return part["text"];
      if (part["type"] === "file" && typeof part["uri"] === "string")
        return `[${typeof part["name"] === "string" ? part["name"] : part["uri"]}]`;
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
};
