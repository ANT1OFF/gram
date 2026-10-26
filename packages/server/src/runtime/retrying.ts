import type { AgentKind } from "@gram/contracts";
import * as Duration from "effect/Duration";

/**
 * The attempt and HTTP status from the prefix an agent's adapter writes itself: Claude's `API retry
 * 1/10 (HTTP 529)` and Codex's `Reconnecting... 1/2 (HTTP 403)`. The rest of the line, and every
 * other agent's, is the API's error message, which may echo the request, so it is never read or
 * logged.
 */
export const retryFacts = (
  agent: AgentKind | undefined,
  detail: string,
): { attempt?: string; httpStatus?: number } => {
  if (agent === "claude") {
    const m = /^API retry (\d{1,3}\/\d{1,3})(?: \(HTTP (\d{3})\))?/.exec(detail);
    if (m === null) return {};
    return { attempt: m[1]!, ...(m[2] === undefined ? {} : { httpStatus: Number(m[2]) }) };
  }
  if (agent === "codex") {
    const m = /^Reconnecting\.\.\. (\d{1,3}\/\d{1,3})(?: \(HTTP (\d{3})\))?$/.exec(detail);
    if (m === null) return {};
    return { attempt: m[1]!, ...(m[2] === undefined ? {} : { httpStatus: Number(m[2]) }) };
  }
  return {};
};

/** How long an agent may retry one turn before the turn is stopped (`ServerConfig.retryDeadline`). */
export const RETRY_DEADLINE = Duration.minutes(10);
