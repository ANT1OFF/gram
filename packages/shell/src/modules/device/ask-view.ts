import { type CommandDisplay, displayCommand } from "@gram/contracts";
import { commandFacts, commandFactText } from "./command-facts.ts";
import type { AskRequest } from "./gate.ts";

/**
 * What the ask window draws, worked out in the main process from what the gate asks. Every field
 * is text the page draws as text: what the app vouches for apart from what the server says, the
 * command as it will run, and the facts a parse of it gives.
 */
export interface AskView {
  /** "Run a command", "Read a file", "List a folder". */
  readonly heading: string;
  readonly kind: "exec" | "read" | "list";
  /** Vouched for by this app. */
  readonly server: string;
  readonly folderPath: string;
  /** "You wrote to this thread from this computer at 14:02." */
  readonly grantLine: string;
  /** The server's word, each drawn so nothing in it hides. */
  readonly says: ReadonlyArray<{ readonly label: string; readonly display: CommandDisplay }>;
  /** The command, whole; for a read or a listing, the real path. */
  readonly target: CommandDisplay;
  readonly targetLabel: string;
  /** For a read: its size, in words. */
  readonly size?: string;
  /** What the command is made of. Never empty for a command, and never a verdict. */
  readonly facts: ReadonlyArray<string>;
  /** Warnings drawn above everything else. */
  readonly warnings: ReadonlyArray<string>;
  readonly allowLabel: string;
  readonly refuseLabel: string;
}

const time = (ms: number): string => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

const bytes = (size: number): string =>
  size < 1024
    ? `${size} bytes`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

export interface AskViewFor {
  readonly request: AskRequest;
  /** "this Mac" or "this computer". */
  readonly machine: string;
  /** The person's local clock, for the grant's time. */
  readonly local?: (ms: number) => string;
  /** When the folder's git HEAD or index changed since the last command allowed in it. */
  readonly folderChanged?: boolean;
}

export const askView = ({ request, machine, local = time, folderChanged }: AskViewFor): AskView => {
  const { approval } = request;
  const kind = approval.kind;
  const says = [
    { label: "Workspace", display: displayCommand(approval.workspace) },
    { label: "Thread", display: displayCommand(request.thread.title) },
    { label: "Asked by", display: displayCommand(request.actorName) },
    ...(request.reason === undefined || request.reason === ""
      ? []
      : [{ label: "Why", display: displayCommand(request.reason) }]),
  ];
  const warnings: Array<string> = [];
  if (request.display.hidden) warnings.push("This has characters you can't see, drawn as codes.");
  if (request.display.nonAscii)
    warnings.push("This has letters outside plain English text, which can look like others.");
  if (request.othersWrote)
    warnings.push("The server says someone else also wrote to this thread since you did.");
  if (says.some(({ display }) => display.hidden))
    warnings.push("What the server says has characters you can't see, drawn as codes.");
  let facts: ReadonlyArray<string> = [];
  if (kind === "exec") {
    const parsed = commandFacts(approval.command, {
      folder: approval.folder,
      cwd: approval.target,
    });
    facts = [
      ...(parsed.parsed ? [] : ["Gram couldn't read this command whole. Read it yourself."]),
      ...(parsed.programs.length > 0 ? [`Runs ${parsed.programs.join(", ")}`] : []),
      ...parsed.facts.map(commandFactText),
      ...(folderChanged === true
        ? ["The folder changed since you last allowed a command here."]
        : []),
    ];
    if (facts.length === 0) facts = ["Runs nothing Gram can name."];
  }
  return {
    heading: kind === "exec" ? "Run a command" : kind === "read" ? "Read a file" : "List a folder",
    kind,
    server: approval.origin,
    folderPath: approval.folder,
    grantLine: `You wrote to this thread from ${machine} at ${local(request.grantIssuedAt)}.`,
    says,
    target: kind === "exec" ? request.display : displayCommand(approval.target),
    targetLabel: kind === "exec" ? "The command, as it will run" : "The real path",
    ...(request.size === undefined ? {} : { size: bytes(request.size) }),
    facts,
    warnings,
    allowLabel: kind === "exec" ? "Run once" : kind === "read" ? "Read once" : "List once",
    refuseLabel: kind === "exec" ? "Don't run" : kind === "read" ? "Don't read" : "Don't list",
  };
};
