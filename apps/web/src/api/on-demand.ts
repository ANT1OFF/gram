import { serverUrl } from "./server-base";

// A person's own machine, where the server's deployment starts one on demand (the server's
// `embedding/on-demand.ts`). Each call is its own HTTP request, so the fronting proxy can sign it
// as this person's: the start is the deployment's proof that they asked. The paths answer 404 on a
// server whose deployment starts none, and the feature is then simply not offered.

export const ON_DEMAND_START_PATH = "/machines/on-demand/start";
export const ON_DEMAND_STOP_PATH = "/machines/on-demand/stop";
export const ON_DEMAND_STATUS_PATH = "/machines/on-demand/status";

export type OnDemandPhase =
  | "starting"
  | "booting"
  | "joining"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface OnDemandStatus {
  readonly available: true;
  /** Their own machine, once one was started and joined. */
  readonly machine?: { readonly id: string; readonly name: string; readonly online: boolean };
  /** How the latest start goes, as the deployment reported it. */
  readonly progress?: {
    readonly hostKey: string;
    readonly phase: OnDemandPhase;
    readonly step?: string;
    readonly message?: string;
    readonly at: number;
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

/** The server's answer, read field by field. Undefined: not one. */
export const parseStatus = (value: unknown): OnDemandStatus | undefined => {
  const body = record(value);
  if (body?.["available"] !== true) return undefined;
  const machine = record(body["machine"]);
  const progress = record(body["progress"]);
  return {
    available: true,
    ...(machine !== undefined &&
    typeof machine["id"] === "string" &&
    typeof machine["name"] === "string"
      ? {
          machine: { id: machine["id"], name: machine["name"], online: machine["online"] === true },
        }
      : {}),
    ...(progress !== undefined &&
    typeof progress["hostKey"] === "string" &&
    typeof progress["phase"] === "string"
      ? {
          progress: {
            hostKey: progress["hostKey"],
            phase: progress["phase"] as OnDemandPhase,
            ...(typeof progress["step"] === "string" ? { step: progress["step"] } : {}),
            ...(typeof progress["message"] === "string" ? { message: progress["message"] } : {}),
            at: typeof progress["at"] === "number" ? progress["at"] : 0,
          },
        }
      : {}),
  };
};

/** Their status, or undefined where the server's deployment starts no machines. */
export const fetchOnDemandStatus = async (): Promise<OnDemandStatus | undefined> => {
  const response = await fetch(serverUrl(ON_DEMAND_STATUS_PATH), {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`The machine's status wasn't read (${response.status}).`);
  return parseStatus(await response.json());
};

const post = async (path: string, body: unknown): Promise<void> => {
  const response = await fetch(serverUrl(path), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  const value = record(await response.json().catch(() => undefined));
  throw new Error(
    typeof value?.["message"] === "string"
      ? value["message"]
      : `It didn't start (${response.status}).`,
  );
};

/** Asks for a machine of this person's own, with the repositories it may use. */
export const startOnDemand = (repositories: ReadonlyArray<string>) =>
  post(ON_DEMAND_START_PATH, { repositories });
export const stopOnDemand = () => post(ON_DEMAND_STOP_PATH, {});

/** A machine still on its way up: asked every second, otherwise every half minute. */
export const isComing = (status: OnDemandStatus | undefined): boolean => {
  const phase = status?.progress?.phase;
  return (
    phase === "starting" ||
    phase === "booting" ||
    phase === "joining" ||
    (phase === "ready" && status?.machine?.online !== true)
  );
};
