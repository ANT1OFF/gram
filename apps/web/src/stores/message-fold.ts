// Folds `UIMessageChunk`s into a `UIMessage` with the semantics of the AI SDK's
// `processUIMessageStream`, which the server's `MessageAccumulator` mirrors too, but in O(1) per
// chunk. The SDK's `readUIMessageStream` deep-clones the whole message for every chunk, and one
// agent turn is one message: a real 626-part turn replayed to a late subscriber is ~15,000 chunks,
// which cost a single 5 s main-thread task on opening the thread.
//
// Parts are never mutated once created: a chunk replaces the part it touches, so a snapshot shares
// every other part with the previous one and memoized rows can skip them.
import type { GramUIMessage, GramUIMessageChunk } from "@gram/contracts";
import { parsePartialJson } from "ai";

type Part = Record<string, unknown> & { type: string };
type LooseChunk = Record<string, unknown> & { type: string };

interface PartialToolCall {
  /** The input JSON streamed so far. */
  text: string;
  /** How much of `text` the part's `input` reflects. */
  parsed: number;
  toolName: unknown;
  dynamic: boolean;
  title: unknown;
  toolMetadata: unknown;
}

export interface MessageFold {
  /** Applies one chunk. Problems the SDK would throw for go to `onError` and the chunk is dropped. */
  apply(chunk: GramUIMessageChunk): void;
  /** The message so far; the same object until a chunk changes it. */
  snapshot(): GramUIMessage;
  /**
   * Parses the input of tool calls still streaming it, which `apply` leaves alone: parsing on every
   * delta re-reads the whole input each time, and a replay has the final input a few chunks later
   * anyway. Resolves true when a part changed.
   */
  parsePartialInputs(): Promise<boolean>;
}

const isTool = (part: Part) => part.type === "dynamic-tool" || part.type.startsWith("tool-");

const toolNameOf = (part: Part) =>
  part.type === "dynamic-tool" ? part["toolName"] : part.type.slice("tool-".length);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The SDK's metadata merge, except that agent message ids accumulate, as the server stores them. */
function mergeMetadata(
  base: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || key === "__proto__" || key === "constructor") continue;
    const previous = result[key];
    if (key === "agentMessageIds" && Array.isArray(previous) && Array.isArray(value)) {
      result[key] = [...new Set([...(previous as unknown[]), ...(value as unknown[])])];
    } else if (isPlainObject(value) && isPlainObject(previous)) {
      result[key] = mergeMetadata(previous, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const withoutUndefined = (part: Part): Part => {
  for (const key of Object.keys(part)) if (part[key] === undefined) delete part[key];
  return part;
};

/** Starts a fold for `messageId`, continuing `base` when the message already has stored parts. */
export function createMessageFold(
  messageId: string,
  options: { base?: GramUIMessage | undefined; onError?: (error: unknown) => void } = {},
): MessageFold {
  const base = options.base?.role === "assistant" ? options.base : undefined;
  let id = base?.id ?? messageId;
  let metadata = base?.metadata as Record<string, unknown> | undefined;
  const parts: Part[] = base ? [...(base.parts as unknown as Part[])] : [];
  let published: GramUIMessage | undefined;

  const activeText = new Map<string, number>();
  const activeReasoning = new Map<string, number>();
  const partialToolCalls = new Map<string, PartialToolCall>();
  const toolIndex = new Map<string, number>();
  const storedLastStep = parts.findLastIndex((part) => part.type === "step-start");
  parts.forEach((part, index) => {
    if (isTool(part)) toolIndex.set(String(part["toolCallId"]), index);
    if (index > storedLastStep && isTool(part) && part["state"] === "input-streaming") {
      const text = typeof part["rawInput"] === "string" ? part["rawInput"] : "";
      partialToolCalls.set(String(part["toolCallId"]), {
        text,
        parsed: text.length,
        toolName: toolNameOf(part),
        dynamic: part.type === "dynamic-tool",
        title: part["title"],
        toolMetadata: part["toolMetadata"],
      });
    }
  });

  const fail = (chunk: LooseChunk, what: string) =>
    options.onError?.(new Error(`${chunk.type}: no ${what} to apply it to`));

  const replace = (index: number, part: Part) => {
    parts[index] = part;
    published = undefined;
  };
  const push = (part: Part) => {
    parts.push(part);
    published = undefined;
    return parts.length - 1;
  };

  /**
   * The SDK's `updateToolPart` and `updateDynamicToolPart`: `input`, `output`, `errorText` and
   * `preliminary` are set to what the chunk carries, so a field it leaves out is cleared.
   */
  const updateTool = (
    c: LooseChunk,
    update: {
      state: string;
      toolName: unknown;
      dynamic: boolean;
      input?: unknown;
      output?: unknown;
      errorText?: unknown;
      rawInput?: unknown;
      title?: unknown;
      toolMetadata?: unknown;
    },
  ) => {
    const toolCallId = String(c["toolCallId"]);
    const index = toolIndex.get(toolCallId);
    const existing = index === undefined ? undefined : parts[index];
    const dynamic = existing === undefined ? update.dynamic : existing.type === "dynamic-tool";
    const settled = update.state === "output-available" || update.state === "output-error";
    const part = withoutUndefined({
      ...existing,
      type: dynamic ? "dynamic-tool" : (existing?.type ?? `tool-${String(update.toolName)}`),
      ...(dynamic ? { toolName: update.toolName } : {}),
      toolCallId,
      state: update.state,
      input: update.input,
      output: update.output,
      errorText: update.errorText,
      rawInput: update.rawInput,
      preliminary: c["preliminary"],
      title: update.title ?? existing?.["title"],
      toolMetadata: update.toolMetadata ?? existing?.["toolMetadata"],
      providerExecuted: c["providerExecuted"] ?? existing?.["providerExecuted"],
      ...(c["providerMetadata"] == null
        ? {}
        : { [settled ? "resultProviderMetadata" : "callProviderMetadata"]: c["providerMetadata"] }),
    });
    if (index === undefined) toolIndex.set(toolCallId, push(part));
    else replace(index, part);
  };

  const toolFor = (c: LooseChunk): Part | undefined => {
    const index = toolIndex.get(String(c["toolCallId"]));
    if (index === undefined) fail(c, "tool call");
    return index === undefined ? undefined : parts[index];
  };

  const streamed = (c: LooseChunk, active: Map<string, number>) => {
    const index = active.get(String(c["id"]));
    if (index === undefined) fail(c, "open part");
    return index;
  };

  return {
    apply(chunk) {
      const c = chunk as unknown as LooseChunk;
      if (c.type === "start" && typeof c["messageId"] === "string" && c["messageId"] !== id) {
        id = c["messageId"];
        published = undefined;
      }
      switch (c.type) {
        case "start":
        case "finish":
        case "message-metadata":
          if (isPlainObject(c["messageMetadata"])) {
            metadata = mergeMetadata(metadata, c["messageMetadata"]);
            published = undefined;
          }
          return;
        case "error":
          options.onError?.(new Error(String(c["errorText"])));
          return;
        case "abort":
        case "finish-step":
          return;
        case "start-step":
          push({ type: "step-start" });
          return;
        case "reset-step": {
          const lastStep = parts.findLastIndex((part) => part.type === "step-start");
          activeText.clear();
          activeReasoning.clear();
          partialToolCalls.clear();
          if (lastStep + 1 === parts.length) return;
          parts.splice(lastStep + 1);
          published = undefined;
          for (const [toolCallId, index] of toolIndex) {
            if (index > lastStep) toolIndex.delete(toolCallId);
          }
          return;
        }

        case "text-start":
          activeText.set(
            String(c["id"]),
            push(
              withoutUndefined({
                type: "text",
                text: "",
                providerMetadata: c["providerMetadata"],
                state: "streaming",
              }),
            ),
          );
          return;
        case "reasoning-start":
          activeReasoning.set(
            String(c["id"]),
            push(
              withoutUndefined({
                type: "reasoning",
                id: c["id"],
                text: "",
                providerMetadata: c["providerMetadata"],
                state: "streaming",
              }),
            ),
          );
          return;
        case "text-delta":
        case "reasoning-delta": {
          const index = streamed(c, c.type === "text-delta" ? activeText : activeReasoning);
          if (index === undefined) return;
          const part = parts[index]!;
          replace(index, {
            ...part,
            text: `${String(part["text"])}${String(c["delta"])}`,
            ...(c["providerMetadata"] == null ? {} : { providerMetadata: c["providerMetadata"] }),
          });
          return;
        }
        case "text-end":
        case "reasoning-end": {
          const active = c.type === "text-end" ? activeText : activeReasoning;
          const index = streamed(c, active);
          if (index === undefined) return;
          replace(index, {
            ...parts[index]!,
            state: "done",
            ...(c["providerMetadata"] == null ? {} : { providerMetadata: c["providerMetadata"] }),
          });
          active.delete(String(c["id"]));
          return;
        }

        case "tool-input-start": {
          const dynamic = c["dynamic"] === true;
          partialToolCalls.set(String(c["toolCallId"]), {
            text: "",
            parsed: 0,
            toolName: c["toolName"],
            dynamic,
            title: c["title"],
            toolMetadata: c["toolMetadata"],
          });
          updateTool(c, {
            state: "input-streaming",
            toolName: c["toolName"],
            dynamic,
            title: c["title"],
            toolMetadata: c["toolMetadata"],
          });
          return;
        }
        case "tool-input-delta": {
          const partial = partialToolCalls.get(String(c["toolCallId"]));
          if (partial === undefined) return fail(c, "tool call");
          partial.text += String(c["inputTextDelta"]);
          return;
        }
        case "tool-input-available":
          partialToolCalls.delete(String(c["toolCallId"]));
          updateTool(c, {
            state: "input-available",
            toolName: c["toolName"],
            dynamic: c["dynamic"] === true,
            input: c["input"],
            title: c["title"],
            toolMetadata: c["toolMetadata"],
          });
          return;
        case "tool-input-error": {
          partialToolCalls.delete(String(c["toolCallId"]));
          const index = toolIndex.get(String(c["toolCallId"]));
          const dynamic =
            index === undefined ? c["dynamic"] === true : parts[index]!.type === "dynamic-tool";
          updateTool(c, {
            state: "output-error",
            toolName: c["toolName"],
            dynamic,
            input: c["input"],
            errorText: c["errorText"],
            toolMetadata: c["toolMetadata"],
          });
          return;
        }
        case "tool-approval-request": {
          const part = toolFor(c);
          if (part === undefined) return;
          replace(toolIndex.get(String(c["toolCallId"]))!, {
            ...part,
            state: "approval-requested",
            approval: {
              id: c["approvalId"],
              ...(c["approvalDescriptor"] == null ? {} : { descriptor: c["approvalDescriptor"] }),
              ...(c["reason"] == null ? {} : { requestReason: c["reason"] }),
              ...(c["isAutomatic"] === true ? { isAutomatic: true } : {}),
              ...(c["signature"] == null ? {} : { signature: c["signature"] }),
            },
          });
          return;
        }
        case "tool-approval-response": {
          const index = parts.findIndex(
            (part) =>
              isTool(part) &&
              (part["approval"] as { id?: unknown } | undefined)?.id === c["approvalId"],
          );
          if (index === -1) return fail(c, "approval request");
          const part = parts[index]!;
          replace(index, {
            ...part,
            state: "approval-responded",
            approval: {
              ...(part["approval"] as object),
              id: c["approvalId"],
              approved: c["approved"],
              ...(c["reason"] == null ? {} : { reason: c["reason"] }),
            },
            ...(c["providerExecuted"] == null ? {} : { providerExecuted: c["providerExecuted"] }),
            ...(c["providerMetadata"] == null
              ? {}
              : { callProviderMetadata: c["providerMetadata"] }),
          });
          return;
        }
        case "tool-output-denied": {
          const part = toolFor(c);
          if (part === undefined) return;
          replace(toolIndex.get(String(c["toolCallId"]))!, { ...part, state: "output-denied" });
          return;
        }
        case "tool-output-available":
        case "tool-output-error": {
          const part = toolFor(c);
          if (part === undefined) return;
          partialToolCalls.delete(String(c["toolCallId"]));
          const failed = c.type === "tool-output-error";
          updateTool(c, {
            state: failed ? "output-error" : "output-available",
            toolName: toolNameOf(part),
            dynamic: part.type === "dynamic-tool",
            input: part["input"],
            ...(failed
              ? {
                  errorText: c["errorText"],
                  ...(part.type === "dynamic-tool" ? {} : { rawInput: part["rawInput"] }),
                }
              : { output: c["output"] }),
          });
          return;
        }

        case "file":
        case "reasoning-file":
          push(
            withoutUndefined({
              type: c.type,
              mediaType: c["mediaType"],
              url: c["url"],
              providerMetadata: c["providerMetadata"] ?? undefined,
            }),
          );
          return;
        case "source-url":
          push(
            withoutUndefined({
              type: c.type,
              sourceId: c["sourceId"],
              url: c["url"],
              title: c["title"],
              providerMetadata: c["providerMetadata"],
            }),
          );
          return;
        case "source-document":
          push(
            withoutUndefined({
              type: c.type,
              sourceId: c["sourceId"],
              mediaType: c["mediaType"],
              title: c["title"],
              filename: c["filename"],
              providerMetadata: c["providerMetadata"],
            }),
          );
          return;
        case "custom":
          push(
            withoutUndefined({
              type: c.type,
              kind: c["kind"],
              providerMetadata: c["providerMetadata"],
            }),
          );
          return;
      }

      if (!c.type.startsWith("data-") || c["transient"] === true) return;
      const index =
        c["id"] === undefined
          ? -1
          : parts.findIndex((part) => part.type === c.type && part["id"] === c["id"]);
      if (index === -1) push(withoutUndefined({ type: c.type, id: c["id"], data: c["data"] }));
      else replace(index, { ...parts[index]!, data: c["data"] });
    },

    snapshot() {
      published ??= {
        id,
        role: "assistant",
        ...(metadata === undefined ? {} : { metadata }),
        parts: [...parts],
      } as unknown as GramUIMessage;
      return published;
    },

    async parsePartialInputs() {
      let changed = false;
      for (const [toolCallId, partial] of partialToolCalls) {
        if (partial.parsed === partial.text.length) continue;
        const text = partial.text;
        const length = text.length;
        const { value } = await parsePartialJson(text);
        const index = toolIndex.get(toolCallId);
        // The input may have arrived in full, or the step been reset, while this one was parsed.
        if (partialToolCalls.get(toolCallId) !== partial || index === undefined) continue;
        partial.parsed = length;
        replace(index, withoutUndefined({ ...parts[index]!, input: value, rawInput: text }));
        changed = true;
      }
      return changed;
    },
  };
}
