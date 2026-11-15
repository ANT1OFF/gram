import {
  parseEvent,
  type OpenCodeEvent,
  type OpenCodeModel,
  type OpenCodeModelRef,
  type OpenCodePermission,
  type OpenCodePermissionReply,
  type OpenCodePermissionRule,
  permissionOf,
} from "./protocol.ts";

/** The subset of `fetch` the client needs; injected in tests. */
export type OpenCodeFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

/** A failed call to the server, with its status; the message never carries the password. */
export class OpenCodeRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "OpenCodeRequestError";
  }
}

export interface OpenCodeClientOptions {
  /** `http://127.0.0.1:<port>`, as `opencode serve` printed it. */
  readonly baseUrl: string;
  /** The server's password (`OPENCODE_SERVER_PASSWORD`), sent as Basic auth for `opencode`. */
  readonly password: string;
  readonly fetch?: OpenCodeFetch;
}

export interface OpenCodeSessionInfo {
  readonly id: string;
  readonly title?: string;
  readonly directory?: string;
  readonly updated?: number;
  readonly created?: number;
  /** The session a subagent's session was made from. */
  readonly parentID?: string;
}

export interface OpenCodeClient {
  createSession(input: {
    readonly directory: string;
    readonly model?: OpenCodeModelRef;
    readonly agent?: string;
    readonly permissions?: ReadonlyArray<OpenCodePermissionRule>;
  }): Promise<OpenCodeSessionInfo>;
  getSession(sessionId: string): Promise<OpenCodeSessionInfo | undefined>;
  listSessions(directory: string, limit: number): Promise<ReadonlyArray<OpenCodeSessionInfo>>;
  /** Starts a turn, or (`steer`) delivers mid-turn at the next step. */
  prompt(sessionId: string, text: string, delivery?: "steer" | "queue"): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  setPermissions(sessionId: string, rules: ReadonlyArray<OpenCodePermissionRule>): Promise<void>;
  setAgent(sessionId: string, agent: string): Promise<void>;
  setModel(sessionId: string, model: OpenCodeModelRef): Promise<void>;
  permissions(sessionId: string): Promise<ReadonlyArray<OpenCodePermission>>;
  reply(
    sessionId: string,
    requestId: string,
    decision: OpenCodePermissionReply,
    message?: string,
  ): Promise<void>;
  models(directory: string): Promise<ReadonlyArray<OpenCodeModel>>;
  /**
   * Reads `GET /api/event` until `signal` aborts or the server closes it, handing each event to
   * `onEvent`. Resolves when the stream ends; rejects when it can't be opened.
   */
  subscribe(onEvent: (event: OpenCodeEvent) => void, signal: AbortSignal): Promise<void>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sessionInfo = (value: unknown): OpenCodeSessionInfo | undefined => {
  if (!isRecord(value) || typeof value["id"] !== "string") return undefined;
  const time = isRecord(value["time"]) ? value["time"] : {};
  const location = isRecord(value["location"]) ? value["location"] : {};
  return {
    id: value["id"],
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof location["directory"] === "string" ? { directory: location["directory"] } : {}),
    ...(typeof time["updated"] === "number" ? { updated: time["updated"] } : {}),
    ...(typeof time["created"] === "number" ? { created: time["created"] } : {}),
    ...(typeof value["parentID"] === "string" ? { parentID: value["parentID"] } : {}),
  };
};

const sessionPath = (sessionId: string) => `/api/session/${encodeURIComponent(sessionId)}`;

/** `{ data }`, the envelope every `/api` answer comes in. */
const dataOf = (body: unknown): unknown => (isRecord(body) ? body["data"] : undefined);

/** `url` without its trailing slashes, in one pass: `/\/+$/` backtracks on a long run of them. */
const withoutTrailingSlashes = (url: string): string => {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
};

export const makeOpenCodeClient = (options: OpenCodeClientOptions): OpenCodeClient => {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const base = withoutTrailingSlashes(options.baseUrl);
  const auth = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    query?: Readonly<Record<string, string>>,
  ): Promise<unknown> => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await send(url.href, {
      method,
      headers: {
        authorization: auth,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const answer: unknown = await response.json();
        const message = isRecord(answer)
          ? (answer["message"] ??
            (isRecord(answer["error"]) ? answer["error"]["message"] : undefined))
          : undefined;
        if (typeof message === "string") detail = `: ${message}`;
      } catch {
        // No JSON body: the status says enough.
      }
      throw new OpenCodeRequestError(
        response.status,
        `OpenCode answered ${response.status} to ${method} ${path}${detail}`,
      );
    }
    const text = await response.text();
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  };

  return {
    createSession: async ({ directory, model, agent, permissions }) => {
      const created = sessionInfo(
        dataOf(
          await call("POST", "/api/session", {
            location: { directory },
            ...(model === undefined ? {} : { model }),
            ...(agent === undefined ? {} : { agent }),
            ...(permissions === undefined ? {} : { permissions }),
          }),
        ),
      );
      if (created === undefined) throw new OpenCodeRequestError(0, "OpenCode made no session");
      return created;
    },
    getSession: async (sessionId) => {
      try {
        return sessionInfo(dataOf(await call("GET", sessionPath(sessionId))));
      } catch (error) {
        if (error instanceof OpenCodeRequestError && error.status === 404) return undefined;
        throw error;
      }
    },
    listSessions: async (directory, limit) => {
      const list = dataOf(
        await call("GET", "/api/session", undefined, {
          directory,
          limit: String(limit),
          order: "desc",
        }),
      );
      return Array.isArray(list)
        ? list.flatMap((each) => {
            const info = sessionInfo(each);
            return info === undefined ? [] : [info];
          })
        : [];
    },
    prompt: async (sessionId, text, delivery) => {
      await call("POST", `${sessionPath(sessionId)}/prompt`, {
        text,
        ...(delivery === undefined ? {} : { delivery }),
      });
    },
    interrupt: async (sessionId) => {
      await call("POST", `${sessionPath(sessionId)}/interrupt`);
    },
    setPermissions: async (sessionId, rules) => {
      await call("PATCH", sessionPath(sessionId), { permissions: rules });
    },
    setAgent: async (sessionId, agent) => {
      await call("POST", `${sessionPath(sessionId)}/agent`, { agent });
    },
    setModel: async (sessionId, model) => {
      await call("POST", `${sessionPath(sessionId)}/model`, { model });
    },
    permissions: async (sessionId) => {
      const list = dataOf(await call("GET", `${sessionPath(sessionId)}/permission`));
      return Array.isArray(list)
        ? list.flatMap((each) => {
            const permission = permissionOf(each);
            return permission === undefined ? [] : [permission];
          })
        : [];
    },
    reply: async (sessionId, requestId, decision, message) => {
      await call(
        "POST",
        `${sessionPath(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        { decision, ...(message === undefined ? {} : { message }) },
      );
    },
    models: async (directory) => {
      const list = dataOf(await call("GET", "/api/model", undefined, { directory }));
      return Array.isArray(list)
        ? list.filter(
            (each): each is OpenCodeModel =>
              isRecord(each) &&
              typeof each["id"] === "string" &&
              typeof each["providerID"] === "string" &&
              typeof each["name"] === "string",
          )
        : [];
    },
    subscribe: async (onEvent, signal) => {
      const response = await send(`${base}/api/event`, {
        method: "GET",
        headers: { authorization: auth, accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || response.body === null)
        throw new OpenCodeRequestError(response.status, "OpenCode's event stream didn't open");
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const bytes of response.body) {
          buffer += decoder.decode(bytes, { stream: true });
          let end = buffer.indexOf("\n\n");
          while (end !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            const event = data === "" ? undefined : parseEvent(data);
            if (event !== undefined) onEvent(event);
            end = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    },
  };
};
