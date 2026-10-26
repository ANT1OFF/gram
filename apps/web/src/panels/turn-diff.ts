import type { GramUIMessage, TurnId } from "@gram/contracts";

export interface TurnOption {
  turnId: TurnId;
  /** The first line of the user message that started the turn. */
  label: string;
}

const LABEL_MAX = 80;

const firstLine = (message: GramUIMessage) =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim()
    .split("\n")[0]
    ?.slice(0, LABEL_MAX) ?? "";

const topLevel = (message: GramUIMessage) => message.metadata?.parentToolUseId === undefined;

/**
 * The top-level assistant replies with the turn each belongs to. The server stamps the turn on the
 * user message that starts it; replies inherit it unless they carry their own.
 */
function repliesByTurn(
  messages: readonly GramUIMessage[],
): Array<{ message: GramUIMessage; turnId: TurnId; prompt: string }> {
  const replies: Array<{ message: GramUIMessage; turnId: TurnId; prompt: string }> = [];
  let current: TurnId | undefined;
  let prompt = "";
  for (const message of messages) {
    if (!topLevel(message)) continue;
    if (message.role === "user") {
      current = message.metadata?.turnId;
      prompt = firstLine(message);
      continue;
    }
    const turnId = message.metadata?.turnId ?? current;
    if (message.role === "assistant" && turnId !== undefined) {
      replies.push({ message, turnId, prompt });
    }
  }
  return replies;
}

/** Turns that produced a reply, latest first, labelled by the prompt that started them. */
export function turnOptions(messages: readonly GramUIMessage[]): TurnOption[] {
  const turns = new Map<TurnId, string>();
  for (const { turnId, prompt } of repliesByTurn(messages)) {
    if (!turns.has(turnId)) turns.set(turnId, prompt || "Turn");
  }
  return [...turns].map(([turnId, label]) => ({ turnId, label })).toReversed();
}

/** Whether two turn lists would offer the same choices. */
export const sameTurnOptions = (a: readonly TurnOption[], b: readonly TurnOption[]): boolean =>
  a.length === b.length &&
  a.every((turn, i) => turn.turnId === b[i]!.turnId && turn.label === b[i]!.label);

/** Each turn's last top-level assistant message, where its files chip goes. */
export function turnEndMessages(messages: readonly GramUIMessage[]): ReadonlyMap<string, TurnId> {
  const last = new Map<TurnId, string>();
  for (const { message, turnId } of repliesByTurn(messages)) last.set(turnId, message.id);
  return new Map([...last].map(([turnId, messageId]) => [messageId, turnId]));
}

/** A Diff panel target that selects a turn rather than focusing a file. */
export const turnTarget = (turnId: TurnId): string => `turn:${turnId}`;

export const targetTurnId = (target: string): TurnId | undefined =>
  target.startsWith("turn:") ? (target.slice("turn:".length) as TurnId) : undefined;
