import {
  RequestId,
  type ApprovalScope,
  type PendingRequest,
  type RequestAnswer,
} from "@gram/contracts";
import type { OutwardGate } from "../host.ts";
import { gateAsks, gateLevel, outwardKind, type OutwardKind } from "../outward.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { CommandExecutionApprovalDecision } from "./protocol/v2/CommandExecutionApprovalDecision.ts";
import type { FileUpdateChange } from "./protocol/v2/FileUpdateChange.ts";

/** The card id for a Codex server request; ids are per app-server process. */
const requestIdOf = (request: ServerRequest): RequestId => RequestId.make(`codex-${request.id}`);

const commandScopes = (
  available: ReadonlyArray<unknown> | null | undefined,
): Array<ApprovalScope> => {
  if (available === null || available === undefined) return ["once", "session"];
  const scopes: Array<ApprovalScope> = ["once"];
  if (available.includes("acceptForSession")) scopes.push("session");
  if (
    available.some(
      (d) => typeof d === "object" && d !== null && "acceptWithExecpolicyAmendment" in d,
    )
  ) {
    scopes.push("always");
  }
  return scopes;
};

type CommandApproval = Extract<
  ServerRequest,
  { method: "item/commandExecution/requestApproval" }
>["params"];

/**
 * What the command does outwardly, read from the full command line and its parsed actions: the most
 * severe reading of any of them.
 */
const kindOf = (p: CommandApproval): OutwardKind | undefined => {
  const kinds = [p.command, ...(p.commandActions ?? []).map((action) => action.command)].map(
    (command) => (typeof command === "string" ? outwardKind(command) : undefined),
  );
  return kinds.includes("irreversible") ? "irreversible" : kinds.find((kind) => kind !== undefined);
};

/**
 * What a session under the outward gate does with a server request before anyone sees it:
 * - `askOnce`: a command the gate's level asks about. Always a card, and only ever for this one run.
 * - `accept`: answered by the adapter, with no card.
 * - `pass`: the ordinary card.
 */
export type GateVerdict = "askOnce" | "accept" | "pass";

/**
 * The gate's verdict on `request`, for a gate at `level` (every outward command, unless told
 * otherwise). `answersItself` is true in the one mode where Codex is told to ask about every
 * command (`untrusted`) only so the adapter can see them: there, a command the level doesn't ask
 * about (at `irreversible`, a push and a new PR among them) and a file change are accepted unseen,
 * as bypass promises. A request the adapter can't read as one plain command (input to a running
 * terminal, a network or permission grant, no command text) stays a card.
 */
export const gateVerdict = (
  request: ServerRequest,
  answersItself: boolean,
  level: OutwardGate = "all",
): GateVerdict => {
  if (request.method === "item/commandExecution/requestApproval") {
    const p = request.params;
    if (gateAsks(level, kindOf(p))) return "askOnce";
    const plain =
      p.kind === "command" &&
      typeof p.command === "string" &&
      p.command.trim() !== "" &&
      (p.networkApprovalContext ?? null) === null &&
      (p.additionalPermissions ?? null) === null;
    return answersItself && plain ? "accept" : "pass";
  }
  if (request.method === "item/fileChange/requestApproval") {
    // A `grantRoot` asks for standing write access, which is more than the one patch.
    return answersItself && (request.params.grantRoot ?? null) === null ? "accept" : "pass";
  }
  return "pass";
};

/** The result that lets a request the gate accepted run: `accept`, once. */
export const GATE_ACCEPT = { decision: "accept" } as const;

/**
 * Whether "always" is kept off a command's card. Codex's "always" writes a
 * `prefix_rule(..., decision="allow")` into `CODEX_HOME`, and an allow rule runs what it matches
 * with no request at all, in every approval policy. So under a gate no outward command gets one,
 * a push at `irreversible` included: its rule would be a prefix of the forced push the gate still
 * asks about, and at that level no prompt rule on `git push` stands beside it to outrank it.
 */
const withholdsAlways = (level: OutwardGate | undefined, kind: OutwardKind | undefined): boolean =>
  level !== undefined && kind !== undefined;

/**
 * The card for a server request, or `undefined` for requests the adapter declines on its own.
 * `changes` are the file change item's patches, which the approval request doesn't repeat.
 * `gate` is the session's outward gate (`true` being the older spelling of `all`): a command the
 * gate asks about gets a card that offers "once" alone, and any other outward command one without
 * "always" (`withholdsAlways`).
 */
export const toPendingRequest = (
  request: ServerRequest,
  changes: (itemId: string) => ReadonlyArray<FileUpdateChange> | undefined,
  gate: boolean | OutwardGate = false,
): PendingRequest | undefined => {
  const level = gateLevel(gate);
  const id = requestIdOf(request);
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const p = request.params;
      const kind = kindOf(p);
      return {
        kind: "approval",
        id,
        toolUseId: p.itemId,
        toolName: "Bash",
        displayName: "Bash",
        input: {
          command: p.commandActions?.map((action) => action.command).join("; ") || p.command || "",
          ...(p.cwd ? { cwd: p.cwd } : {}),
        },
        ...(p.reason ? { description: p.reason } : {}),
        suggestions: [],
        scopes: gateAsks(level, kind)
          ? ["once"]
          : commandScopes(
              (p as { availableDecisions?: ReadonlyArray<unknown> | null }).availableDecisions,
            ).filter((scope) => scope !== "always" || !withholdsAlways(level, kind)),
      };
    }
    case "item/fileChange/requestApproval": {
      const p = request.params;
      const patches = changes(p.itemId) ?? [];
      return {
        kind: "approval",
        id,
        toolUseId: p.itemId,
        toolName: "Edit",
        displayName: "Edit",
        input: { ...(patches[0] ? { file_path: patches[0].path } : {}), changes: patches },
        ...(p.reason ? { description: p.reason } : {}),
        ...(p.grantRoot ? { blockedPath: p.grantRoot } : {}),
        suggestions: [],
        scopes: ["once", "session"],
      };
    }
    case "item/permissions/requestApproval": {
      const p = request.params;
      return {
        kind: "approval",
        id,
        toolUseId: p.itemId,
        toolName: "permissions",
        displayName: "Permissions",
        input: { permissions: p.permissions, cwd: p.cwd },
        ...(p.reason ? { description: p.reason } : {}),
        suggestions: [],
        scopes: ["once", "session"],
      };
    }
    case "item/tool/requestUserInput": {
      const p = request.params;
      return {
        kind: "question",
        id,
        toolUseId: p.itemId,
        questions: p.questions.map((q) => ({
          question: q.question,
          header: q.header,
          multiSelect: false,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
        })),
      };
    }
    default:
      return undefined;
  }
};

/**
 * The JSON-RPC result answering `request` with the user's `answer`. `gate` is the session's outward
 * gate, as for `toPendingRequest`: what it asks about is accepted for the one run whatever scope
 * the answer names, and no outward command's answer writes a rule. In a gated session a denied
 * command is always `decline`d: under `untrusted` Codex offers only accept and `cancel`, and
 * `cancel` interrupts the whole turn, where `decline` (which it takes all the same) hands the
 * command back to the model as "rejected by user" and lets the work go on without the push.
 */
export const responseFor = (
  request: ServerRequest,
  answer: RequestAnswer,
  gate: boolean | OutwardGate = false,
): unknown => {
  const level = gateLevel(gate);
  const gated = level !== undefined;
  const allow = answer.kind === "approval" && answer.decision === "allow";
  const scope = answer.kind === "approval" ? answer.scope : "once";
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const p = request.params;
      const kind = kindOf(p);
      const available = (p as { availableDecisions?: ReadonlyArray<unknown> | null })
        .availableDecisions;
      const offers = (decision: string) =>
        available === null || available === undefined || available.includes(decision);
      let decision: CommandExecutionApprovalDecision;
      if (!allow) decision = gated || offers("decline") ? "decline" : "cancel";
      else if (gateAsks(level, kind)) decision = "accept";
      else if (
        scope === "always" &&
        p.proposedExecpolicyAmendment &&
        !withholdsAlways(level, kind)
      ) {
        decision = {
          acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment },
        };
      } else
        decision = scope !== "once" && offers("acceptForSession") ? "acceptForSession" : "accept";
      return { decision };
    }
    case "item/fileChange/requestApproval":
      return { decision: !allow ? "decline" : scope === "once" ? "accept" : "acceptForSession" };
    case "item/permissions/requestApproval": {
      const p = request.params;
      return allow
        ? {
            permissions: {
              ...(p.permissions.network ? { network: p.permissions.network } : {}),
              ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}),
            },
            scope: scope === "once" ? "turn" : "session",
          }
        : { permissions: {}, scope: "turn" };
    }
    case "item/tool/requestUserInput": {
      const p = request.params;
      const given = answer.kind === "question" ? answer.answers : {};
      return {
        answers: Object.fromEntries(
          p.questions.map((q) => [q.id, { answers: [...(given[q.question] ?? [])] }]),
        ),
      };
    }
    default:
      return { decision: "cancel" };
  }
};
