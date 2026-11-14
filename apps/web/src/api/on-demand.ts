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

/** One option of a choice the deployment offers before a machine starts, such as a size. */
export interface OnDemandOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  /** Whether this person may pick it; one they may not is shown with `note` saying why. */
  readonly available: boolean;
  readonly note?: string;
}

export interface OnDemandChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly options: ReadonlyArray<OnDemandOption>;
  readonly default: string;
}

export interface OnDemandStatus {
  readonly available: true;
  /** What the person may pick before it starts, and a line on whose limits they are. */
  readonly choices?: { readonly choices: ReadonlyArray<OnDemandChoice>; readonly note?: string };
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
  const choices = parseChoices(body["choices"]);
  return {
    available: true,
    ...(choices === undefined ? {} : { choices }),
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

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The server already read the provider's choices field by field; this keeps the shape honest. */
const parseChoices = (value: unknown): OnDemandStatus["choices"] => {
  const body = record(value);
  if (body === undefined || !Array.isArray(body["choices"])) return undefined;
  const choices: OnDemandChoice[] = [];
  for (const raw of body["choices"]) {
    const entry = record(raw);
    const id = text(entry?.["id"]);
    const label = text(entry?.["label"]);
    const fallback = text(entry?.["default"]);
    if (!entry || id === undefined || label === undefined || fallback === undefined) continue;
    if (!Array.isArray(entry["options"])) continue;
    const options = entry["options"].flatMap((each): OnDemandOption[] => {
      const option = record(each);
      const optionId = text(option?.["id"]);
      const optionLabel = text(option?.["label"]);
      if (!option || optionId === undefined || optionLabel === undefined) return [];
      const detail = text(option["detail"]);
      const note = text(option["note"]);
      return [
        {
          id: optionId,
          label: optionLabel,
          ...(detail === undefined ? {} : { detail }),
          available: option["available"] !== false,
          ...(note === undefined ? {} : { note }),
        },
      ];
    });
    const description = text(entry["description"]);
    choices.push({
      id,
      label,
      ...(description === undefined ? {} : { description }),
      options,
      default: fallback,
    });
  }
  if (choices.length === 0) return undefined;
  const note = text(body["note"]);
  return { choices, ...(note === undefined ? {} : { note }) };
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

/** Asks for a machine of this person's own, with the repositories it may use and what they picked. */
export const startOnDemand = (
  repositories: ReadonlyArray<string>,
  choices: Readonly<Record<string, string>> = {},
) =>
  post(ON_DEMAND_START_PATH, {
    repositories,
    ...(Object.keys(choices).length === 0 ? {} : { choices }),
  });
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
