import { HOSTED_THREAD_ID } from "@gram/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Text = (most: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(most));
const Said = Text(20_000).check(Schema.makeFilter((said: string) => said.trim() !== ""));
const ClientKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/));
const Repositories = Schema.Array(
  Schema.String.check(Schema.isPattern(/^(?!-)[\x21-\x7e]{3,512}$/)),
).check(Schema.isMinLength(1), Schema.isMaxLength(8));
const Branch = Schema.String.check(
  Schema.isPattern(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/),
);

const decodeThreadId = Schema.decodeUnknownOption(
  Schema.Struct({ threadId: Text(128).check(Schema.isPattern(HOSTED_THREAD_ID)) }),
);

/** A thread's id on a server, as it named one sent from here. */
export const hostedThreadIdOf = (arg: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodeThreadId(arg), ({ threadId }) => threadId));

const decodeRepositories = Schema.decodeUnknownOption(Repositories);

/** The repositories a check names, as a send would: undefined when they aren't. */
export const repositoriesToCheckOf = (repositories: unknown): string[] | undefined =>
  Option.getOrUndefined(Option.map(decodeRepositories(repositories), (each) => [...each]));

const decodeWork = Schema.decodeUnknownOption(
  Schema.Struct({
    work: Schema.Struct({
      repositories: Repositories,
      text: Said,
      clientKey: ClientKey,
      title: Schema.optional(Text(200)),
      branch: Schema.optional(Branch),
    }),
  }),
);

/** Work a window asks to send, or undefined when any of it isn't what a server takes. */
export const workToSendOf = (arg: unknown) =>
  Option.getOrUndefined(
    Option.map(decodeWork(arg), ({ work: { repositories, text, clientKey, title, branch } }) => ({
      repositories: [...repositories],
      text,
      clientKey,
      ...(title === undefined ? {} : { title }),
      ...(branch === undefined ? {} : { branch }),
    })),
  );

const decodeWait = Schema.decodeUnknownOption(
  Schema.Struct({
    after: Schema.optional(Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,200}$/))),
    until: Schema.optional(Schema.Literals(["reply", "idle", "waiting", "message"])),
    timeoutSeconds: Schema.optional(Schema.Number.check(Schema.makeFilter(Number.isInteger))),
  }),
);

/** What to wait for, from a request's own `after`, `until` and `timeoutSeconds`. */
export const workWaitFrom = (fields: object) =>
  Option.getOrUndefined(
    Option.map(decodeWait(fields), ({ after, until, timeoutSeconds }) => ({
      ...(after === undefined ? {} : { after }),
      ...(until === undefined ? {} : { until }),
      ...(timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: Math.max(1, Math.min(20, timeoutSeconds)) }),
    })),
  );

/** What to wait for, as a window asks: undefined when it isn't a wait. */
export const workWaitOf = (arg: unknown) => {
  const wait = typeof arg === "object" && arg !== null && "wait" in arg ? arg.wait : undefined;
  return workWaitFrom(
    typeof wait === "object" && wait !== null && !Array.isArray(wait) ? wait : {},
  );
};

const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    text: Said,
    clientKey: ClientKey,
    mode: Schema.optional(Schema.Literals(["queue", "steer", "interrupt"])),
  }),
);

/** A message to send into a thread sent from here, from a request's own fields. */
export const workMessageFrom = (fields: object) =>
  Option.getOrUndefined(
    Option.map(decodeMessage(fields), ({ text, clientKey, mode }) => ({
      text,
      clientKey,
      ...(mode === undefined ? {} : { mode }),
    })),
  );

/** A message a window asks to send into a thread sent from here. */
export const workMessageOf = (arg: unknown) => {
  const message =
    typeof arg === "object" && arg !== null && "message" in arg ? arg.message : undefined;
  return typeof message === "object" && message !== null ? workMessageFrom(message) : undefined;
};
