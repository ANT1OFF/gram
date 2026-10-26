import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate as SdkPermissionUpdate,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  RequestId,
  type PendingRequest,
  type PermissionMode,
  type PermissionUpdate,
  type Question,
  type RequestAnswer,
} from "@gram/contracts";
import { outwardKind, type OutwardKind } from "../outward.ts";

export type CanUseToolOptions = Parameters<CanUseTool>[2];

const asRecord = (u: unknown): Record<string, unknown> =>
  typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {};

const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined);

const decodeQuestions = (input: Record<string, unknown>): Array<Question> =>
  (Array.isArray(input["questions"]) ? input["questions"] : []).map((raw) => {
    const q = asRecord(raw);
    return {
      question: str(q["question"]) ?? "",
      header: str(q["header"]) ?? "",
      multiSelect: q["multiSelect"] === true,
      options: (Array.isArray(q["options"]) ? q["options"] : []).map((rawOption) => {
        const o = asRecord(rawOption);
        const preview = str(o["preview"]);
        return {
          label: str(o["label"]) ?? "",
          description: str(o["description"]) ?? "",
          ...(preview === undefined ? {} : { preview }),
        };
      }),
    };
  });

/**
 * What a `Bash` call does outwardly by an ordinary spelling (`outwardKind`), or `undefined` for an
 * inward command and for any other tool. The `PreToolUse` hook and the card it leads to both decide
 * by this and the session's gate level (`gateAsks`), so the card that a hook's "ask" raises is the
 * one that is limited to "once".
 */
export const outwardBashKind = (toolName: string, input: unknown): OutwardKind | undefined => {
  if (toolName !== "Bash") return undefined;
  const command = asRecord(input)["command"];
  return typeof command === "string" ? outwardKind(command) : undefined;
};

/** A `Bash` call that pushes, or opens, merges or closes a PR: what a gate at `all` asks about. */
export const isOutwardBash = (toolName: string, input: unknown): boolean =>
  outwardBashKind(toolName, input) !== undefined;

/**
 * The card for a `canUseTool` call: `AskUserQuestion` → question, `ExitPlanMode` → plan, anything
 * else → approval. `suppressAlways` (set by the SDK, and for a `Bash` command the session's outward
 * gate asks about) limits the card to "once" and drops the suggestions, so no rule can be written.
 */
export const toPendingRequest = (
  toolName: string,
  input: Record<string, unknown>,
  options: Omit<CanUseToolOptions, "signal">,
  suppressAlways = false,
): PendingRequest => {
  const common = { id: RequestId.make(options.requestId), toolUseId: options.toolUseID };
  if (toolName === "AskUserQuestion") {
    return { kind: "question", ...common, questions: decodeQuestions(input) };
  }
  if (toolName === "ExitPlanMode") {
    const planFilePath = str(input["planFilePath"]);
    return {
      kind: "plan",
      ...common,
      plan: str(input["plan"]) ?? "",
      ...(planFilePath === undefined ? {} : { planFilePath }),
    };
  }
  const suppress = suppressAlways || options.suppressAlwaysAllowRule === true;
  return {
    kind: "approval",
    ...common,
    toolName,
    displayName: options.displayName ?? toolName,
    input,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
    ...(options.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
    suggestions: suppress ? [] : (options.suggestions ?? []),
    scopes: suppress ? ["once"] : ["once", "session", "always"],
  };
};

const toSdkUpdate = (update: PermissionUpdate): SdkPermissionUpdate => {
  switch (update.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules":
      return { ...update, rules: update.rules.map((rule) => ({ ...rule })) };
    case "addDirectories":
    case "removeDirectories":
      return { ...update, directories: [...update.directories] };
    case "setMode":
      return { ...update };
  }
};

/** `settingSources` undefined means the SDK default (user, project, local). */
const loadsLocalSettings = (settingSources: ReadonlyArray<SettingSource> | undefined): boolean =>
  settingSources === undefined || settingSources.includes("local");

export interface Resolution {
  readonly result: PermissionResult;
  /** Switch the session's permission mode before returning (plan approval). */
  readonly setMode?: PermissionMode;
}

/**
 * Multi-select answers are comma-separated in `updatedInput.answers`, keyed by question text
 * (`AskUserQuestionOutput.answers` in the SDK's `sdk-tools.d.ts`).
 */
const MULTI_SELECT_SEPARATOR = ", ";

export const resolveRequest = (
  request: PendingRequest,
  input: Record<string, unknown>,
  answer: RequestAnswer,
  settingSources: ReadonlyArray<SettingSource> | undefined,
): Resolution => {
  const toolUseID = request.toolUseId;
  const withId = <R extends PermissionResult>(r: R): R =>
    toolUseID === undefined ? r : { ...r, toolUseID };

  if (request.kind === "approval" && answer.kind === "approval") {
    if (answer.decision === "deny") {
      return {
        result: withId({
          behavior: "deny",
          message: answer.message ?? "The user denied this tool call.",
        }),
      };
    }
    const suggestions = request.suggestions.map(toSdkUpdate);
    const updatedPermissions =
      answer.scope === "once"
        ? []
        : answer.scope === "session"
          ? suggestions.map((u) => ({ ...u, destination: "session" as const }))
          : loadsLocalSettings(settingSources)
            ? suggestions
            : // Rules written to settings only take effect in-session while their source is loaded.
              [
                ...suggestions,
                ...suggestions
                  .filter((u) => u.destination !== "session")
                  .map((u) => ({ ...u, destination: "session" as const })),
              ];
    return {
      result: withId({
        behavior: "allow",
        updatedInput: input,
        ...(updatedPermissions.length ? { updatedPermissions } : {}),
      }),
    };
  }

  if (request.kind === "question" && answer.kind === "question") {
    const answers: Record<string, string> = {};
    for (const q of request.questions) {
      const selected = answer.answers[q.question];
      if (selected?.length) answers[q.question] = selected.join(MULTI_SELECT_SEPARATOR);
    }
    return { result: withId({ behavior: "allow", updatedInput: { ...input, answers } }) };
  }

  if (request.kind === "plan" && answer.kind === "plan") {
    return answer.decision === "approve"
      ? {
          result: withId({ behavior: "allow", updatedInput: input }),
          setMode: answer.mode ?? "acceptEdits",
        }
      : {
          result: withId({
            behavior: "deny",
            message:
              answer.message ?? "The user rejected the plan. Stay in plan mode and revise it.",
          }),
        };
  }

  return {
    result: withId({
      behavior: "deny",
      message: `Gram received a ${answer.kind} answer for a ${request.kind} request.`,
    }),
  };
};
