import { HostFailed } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { forgetClaudeToken, NOT_A_CLAUDE_TOKEN, writeClaudeToken } from "./host-config.ts";
import type { HostClaudeToken } from "./protocol.ts";

/**
 * A failed step as the main machine reads it: a refused shape as `NOT_A_CLAUDE_TOKEN`, a file
 * error by its code only. Never the token, nor a message that could quote it.
 */
const failed = (step: string) => (error: unknown) =>
  new HostFailed({
    message:
      error instanceof Error && error.message === NOT_A_CLAUDE_TOKEN
        ? NOT_A_CLAUDE_TOKEN
        : `Couldn't ${step} the Claude token: ${error instanceof Error && "code" in error ? String(error.code) : "file error"}.`,
  });

/** A joined machine's token, kept owner-only in its host folder `home`. */
export const claudeTokenIn = (home: string): HostClaudeToken => ({
  setToken: (token) =>
    Effect.try({
      try: () => writeClaudeToken(home, Redacted.value(token)),
      catch: failed("keep"),
    }),
  forgetToken: Effect.try({ try: () => forgetClaudeToken(home), catch: failed("delete") }),
});
