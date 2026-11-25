import { serverUrl } from "./server-base";
import { withOriginKey } from "./origin-key";

export const ON_DEMAND_START_PATH = "/machines/on-demand/start";
export const ON_DEMAND_STOP_PATH = "/machines/on-demand/stop";
export const ON_DEMAND_STATUS_PATH = "/machines/on-demand/status";
export const ON_DEMAND_PREFERENCES_PATH = "/machines/on-demand/preferences";

const ON_DEMAND_PHASES = [
  "starting",
  "booting",
  "joining",
  "ready",
  "stopping",
  "stopped",
  "failed",
] as const;
export type OnDemandPhase = (typeof ON_DEMAND_PHASES)[number];
const isPhase = (value: unknown): value is OnDemandPhase =>
  ON_DEMAND_PHASES.some((phase) => phase === value);

/** One option of a choice the deployment offers before a machine starts, such as a size. */
export interface OnDemandOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  /** Whether this person may pick it; one they may not is shown with `note` saying why. */
  readonly available: boolean;
  readonly note?: string;
  /** A shorter label, for the chip and narrow rows. */
  readonly short?: string;
}

export interface OnDemandChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly options: ReadonlyArray<OnDemandOption>;
  /** What a start that names nothing gets: their own pick where they kept one. */
  readonly default: string;
  /** What `default` is when they keep no pick of their own. */
  readonly fallback?: string;
  /** What their machine has now. */
  readonly current?: string;
}

export interface OnDemandStatus {
  readonly available: true;
  /** What the person may pick before it starts, and a line on whose limits they are. */
  readonly choices?: {
    readonly choices: ReadonlyArray<OnDemandChoice>;
    readonly note?: string;
    /** Whether the deployment keeps a person's picks as theirs. */
    readonly keeps?: boolean;
  };
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
    isPhase(progress["phase"])
      ? {
          progress: {
            hostKey: progress["hostKey"],
            phase: progress["phase"],
            ...(typeof progress["step"] === "string" ? { step: progress["step"] } : {}),
            ...(typeof progress["message"] === "string" ? { message: progress["message"] } : {}),
            at: typeof progress["at"] === "number" ? progress["at"] : 0,
          },
        }
      : {}),
  };
};

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

const parseChoices = (value: unknown): OnDemandStatus["choices"] => {
  const body = record(value);
  if (body === undefined || !Array.isArray(body["choices"])) return undefined;
  const choices: OnDemandChoice[] = [];
  for (const raw of body["choices"]) {
    const entry = record(raw);
    const id = text(entry?.["id"]);
    const label = text(entry?.["label"]);
    const chosen = text(entry?.["default"]);
    if (!entry || id === undefined || label === undefined || chosen === undefined) continue;
    if (!Array.isArray(entry["options"])) continue;
    const options = entry["options"].flatMap((each): OnDemandOption[] => {
      const option = record(each);
      const optionId = text(option?.["id"]);
      const optionLabel = text(option?.["label"]);
      if (!option || optionId === undefined || optionLabel === undefined) return [];
      const detail = text(option["detail"]);
      const note = text(option["note"]);
      const short = text(option["short"]);
      return [
        {
          id: optionId,
          label: optionLabel,
          ...(detail === undefined ? {} : { detail }),
          available: option["available"] !== false,
          ...(note === undefined ? {} : { note }),
          ...(short === undefined ? {} : { short }),
        },
      ];
    });
    const description = text(entry["description"]);
    const named = (key: string) => {
      const optionId = text(entry[key]);
      return optionId !== undefined && options.some((option) => option.id === optionId)
        ? optionId
        : undefined;
    };
    const base = named("fallback");
    const current = named("current");
    choices.push({
      id,
      label,
      ...(description === undefined ? {} : { description }),
      options,
      default: chosen,
      ...(base === undefined ? {} : { fallback: base }),
      ...(current === undefined ? {} : { current }),
    });
  }
  if (choices.length === 0) return undefined;
  const note = text(body["note"]);
  return {
    choices,
    ...(note === undefined ? {} : { note }),
    ...(body["keeps"] === true ? { keeps: true } : {}),
  };
};

/** Their status, or undefined where the server's deployment starts no machines. */
export const fetchOnDemandStatus = async (
  workspace?: string,
): Promise<OnDemandStatus | undefined> => {
  const query = workspace === undefined ? "" : `?workspace=${encodeURIComponent(workspace)}`;
  const response = await fetch(
    serverUrl(`${ON_DEMAND_STATUS_PATH}${query}`),
    withOriginKey({
      credentials: "same-origin",
      cache: "no-store",
    }),
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`The machine's status wasn't read (${response.status}).`);
  return parseStatus(await response.json());
};

const post = async (path: string, body: unknown): Promise<void> => {
  const response = await fetch(
    serverUrl(path),
    withOriginKey({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
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
  how: { readonly keep?: boolean; readonly restart?: boolean; readonly workspace?: string } = {},
) =>
  post(ON_DEMAND_START_PATH, {
    ...(how.workspace === undefined ? {} : { workspace: how.workspace }),
    repositories,
    ...(Object.keys(choices).length === 0 ? {} : { choices }),
    ...(how.keep === true ? { keep: true } : {}),
    ...(how.restart === true ? { restart: true } : {}),
  });

/** Keeps these picks as the person's own, without starting anything. */
export const keepOnDemandPicks = (choices: Readonly<Record<string, string>>) =>
  post(ON_DEMAND_PREFERENCES_PATH, { choices });
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
