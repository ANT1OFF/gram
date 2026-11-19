// What a window or this machine's server asks to send to a hosted server, read before it goes:
// each part as a server takes it, or nothing at all. Shared by the app's bridge (`main.ts`) and
// the server's requests (`serve-work.ts`).

import { HOSTED_THREAD_ID } from "@gram/contracts";

const text = (value: unknown, most: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= most ? value : undefined;

const field = (arg: unknown, name: string, most: number): string | undefined =>
  typeof arg === "object" && arg !== null ? text(Reflect.get(arg, name), most) : undefined;

/** A thread's id on a server, as it named one sent from here. */
export const hostedThreadIdOf = (arg: unknown): string | undefined => {
  const id = field(arg, "threadId", 128);
  return id !== undefined && HOSTED_THREAD_ID.test(id) ? id : undefined;
};

const CLIENT_KEY = /^[A-Za-z0-9_-]{1,100}$/;
/** A repository as a server takes one: `owner/name` or a git URL, nothing that spans lines. */
const REPOSITORY = /^(?!-)[\x21-\x7e]{3,512}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

const objectOf = (arg: unknown, name: string): object | undefined => {
  const value = typeof arg === "object" && arg !== null ? Reflect.get(arg, name) : undefined;
  return typeof value === "object" && value !== null ? value : undefined;
};

/** Work a window asks to send, or undefined when any of it isn't what a server takes. */
export const workToSendOf = (arg: unknown) => {
  const work = objectOf(arg, "work");
  if (work === undefined) return undefined;
  const repositories = Reflect.get(work, "repositories");
  const said = field(work, "text", 20_000);
  const clientKey = field(work, "clientKey", 100);
  const title = Reflect.get(work, "title");
  const branch = Reflect.get(work, "branch");
  if (
    !Array.isArray(repositories) ||
    repositories.length < 1 ||
    repositories.length > 8 ||
    !repositories.every((each) => typeof each === "string" && REPOSITORY.test(each)) ||
    said === undefined ||
    said.trim() === "" ||
    clientKey === undefined ||
    !CLIENT_KEY.test(clientKey) ||
    (title !== undefined && text(title, 200) === undefined) ||
    (branch !== undefined && (typeof branch !== "string" || !BRANCH.test(branch)))
  )
    return undefined;
  return {
    repositories: repositories as string[],
    text: said,
    clientKey,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof branch === "string" ? { branch } : {}),
  };
};

/** The repositories a check names, as a send would: undefined when they aren't. */
export const repositoriesToCheckOf = (repositories: unknown): string[] | undefined =>
  Array.isArray(repositories) &&
  repositories.length >= 1 &&
  repositories.length <= 8 &&
  repositories.every((each) => typeof each === "string" && REPOSITORY.test(each))
    ? (repositories as string[])
    : undefined;

const UNTIL = new Set(["reply", "idle", "waiting", "message"] as const);
const MODES = new Set(["queue", "steer", "interrupt"] as const);
const isOneOf = <T extends string>(set: ReadonlySet<T>, value: unknown): value is T =>
  typeof value === "string" && set.has(value as T);

/** What to wait for, as a window asks: undefined when it isn't a wait. */
export const workWaitOf = (arg: unknown) => {
  const wait = objectOf(arg, "wait") ?? {};
  const after = Reflect.get(wait, "after");
  const until = Reflect.get(wait, "until");
  const seconds = Reflect.get(wait, "timeoutSeconds");
  if (after !== undefined && (typeof after !== "string" || !/^[\x21-\x7e]{1,200}$/.test(after)))
    return undefined;
  if (until !== undefined && !isOneOf(UNTIL, until)) return undefined;
  if (seconds !== undefined && (typeof seconds !== "number" || !Number.isInteger(seconds)))
    return undefined;
  return {
    ...(after === undefined ? {} : { after }),
    ...(until === undefined ? {} : { until }),
    ...(seconds === undefined ? {} : { timeoutSeconds: Math.max(1, Math.min(20, seconds)) }),
  };
};

/** A message a window asks to send into a thread sent from here. */
export const workMessageOf = (arg: unknown) => {
  const message = objectOf(arg, "message");
  if (message === undefined) return undefined;
  const said = field(message, "text", 20_000);
  const clientKey = field(message, "clientKey", 100);
  const mode = Reflect.get(message, "mode");
  if (
    said === undefined ||
    said.trim() === "" ||
    clientKey === undefined ||
    !CLIENT_KEY.test(clientKey)
  )
    return undefined;
  if (mode !== undefined && !isOneOf(MODES, mode)) return undefined;
  return { text: said, clientKey, ...(mode === undefined ? {} : { mode }) };
};
