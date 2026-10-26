import type { GramUIMessage, GramUIMessageChunk } from "@gram/contracts";

type Part = Record<string, unknown> & { type: string };
type LooseChunk = Record<string, unknown> & { type: string };

/**
 * Folds `UIMessageChunk`s into a `UIMessage` the way the AI SDK's `readUIMessageStream` does, but
 * synchronously, so the runtime can persist a snapshot the moment a part completes.
 */
export class MessageAccumulator {
  private readonly parts: Array<Part> = [];
  private metadata: Record<string, unknown> | undefined;
  private readonly textParts = new Map<string, Part>();
  private readonly reasoningParts = new Map<string, Part>();
  private readonly toolParts = new Map<string, Part>();

  readonly messageId: string;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /** Applies one chunk; true when it completed a part (or the message) and a snapshot is due. */
  apply(chunk: GramUIMessageChunk): boolean {
    const c = chunk as unknown as LooseChunk;
    switch (c.type) {
      case "start":
      case "message-metadata":
        this.mergeMetadata(c["messageMetadata"]);
        return false;
      case "finish":
        this.mergeMetadata(c["messageMetadata"]);
        return true;
      case "abort":
        return true;
      case "start-step":
        this.parts.push({ type: "step-start" });
        return false;
      case "finish-step":
      case "error":
        return false;
      case "reset-step": {
        const lastStep = this.parts.findLastIndex((p) => p.type === "step-start");
        this.parts.splice(lastStep + 1);
        return false;
      }

      case "text-start":
      case "reasoning-start": {
        const part: Part = {
          type: c.type === "text-start" ? "text" : "reasoning",
          text: "",
          state: "streaming",
          ...pick(c, "providerMetadata"),
        };
        this.parts.push(part);
        (c.type === "text-start" ? this.textParts : this.reasoningParts).set(String(c["id"]), part);
        return false;
      }
      case "text-delta":
      case "reasoning-delta": {
        const part = (c.type === "text-delta" ? this.textParts : this.reasoningParts).get(
          String(c["id"]),
        );
        if (part !== undefined) part["text"] = `${String(part["text"])}${String(c["delta"])}`;
        return false;
      }
      case "text-end":
      case "reasoning-end": {
        const part = (c.type === "text-end" ? this.textParts : this.reasoningParts).get(
          String(c["id"]),
        );
        if (part === undefined) return false;
        part["state"] = "done";
        Object.assign(part, pick(c, "providerMetadata"));
        return true;
      }

      case "tool-input-start":
        this.tool(c, { state: "input-streaming", input: undefined });
        return false;
      case "tool-input-delta":
        return false;
      case "tool-input-available":
        this.tool(c, { state: "input-available", input: c["input"] });
        return false;
      case "tool-input-error":
        this.tool(c, { state: "output-error", input: c["input"], errorText: c["errorText"] });
        return true;
      case "tool-approval-request":
        this.tool(c, {
          state: "approval-requested",
          approval: {
            id: c["approvalId"],
            ...pick(c, "isAutomatic", "signature"),
            ...(c["approvalDescriptor"] === undefined
              ? {}
              : { descriptor: c["approvalDescriptor"] }),
            ...(c["reason"] === undefined ? {} : { requestReason: c["reason"] }),
          },
        });
        return false;
      case "tool-approval-response": {
        const part = [...this.toolParts.values()].find(
          (p) => (p["approval"] as { id?: unknown } | undefined)?.id === c["approvalId"],
        );
        if (part === undefined) return false;
        part["state"] = "approval-responded";
        part["approval"] = {
          ...(part["approval"] as object),
          approved: c["approved"],
          ...pick(c, "reason"),
        };
        return false;
      }
      case "tool-output-available":
        this.tool(c, {
          state: "output-available",
          output: c["output"],
          preliminary: c["preliminary"],
        });
        return c["preliminary"] !== true;
      case "tool-output-error":
        this.tool(c, { state: "output-error", errorText: c["errorText"] });
        return true;
      case "tool-output-denied":
        this.tool(c, { state: "output-denied" });
        return true;

      case "source-url":
      case "source-document":
      case "file":
      case "reasoning-file":
      case "custom":
        this.parts.push({ ...c });
        return true;
    }

    if (c.type.startsWith("data-")) {
      if (c["transient"] === true) return false;
      const existing =
        c["id"] === undefined
          ? undefined
          : this.parts.find((p) => p.type === c.type && p["id"] === c["id"]);
      if (existing === undefined) {
        this.parts.push({ type: c.type, ...pick(c, "id"), data: c["data"] });
      } else {
        existing["data"] = c["data"];
      }
      return true;
    }
    return false;
  }

  snapshot(): GramUIMessage {
    return structuredClone({
      id: this.messageId,
      role: "assistant",
      parts: this.parts,
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
    }) as unknown as GramUIMessage;
  }

  /** The tool part for `toolCallId` as it stands, read-only; `undefined` before its first chunk. */
  toolPart(toolCallId: string): Readonly<Part> | undefined {
    return this.toolParts.get(toolCallId);
  }

  /** A provider's output snapshot does not finish the underlying command. */
  preliminaryTools(): readonly string[] {
    return [...this.toolParts.entries()].flatMap(([id, part]) =>
      part["state"] === "output-available" && part["preliminary"] === true ? [id] : [],
    );
  }

  private mergeMetadata(metadata: unknown) {
    if (typeof metadata !== "object" || metadata === null) return;
    const incoming = metadata as Record<string, unknown>;
    const previousIds = this.metadata?.["agentMessageIds"];
    this.metadata = { ...this.metadata, ...incoming };
    // Agent message ids accumulate across chunks (one per SDK content block), in order.
    if (Array.isArray(previousIds) && Array.isArray(incoming["agentMessageIds"])) {
      this.metadata["agentMessageIds"] = [
        ...new Set([
          ...(previousIds as Array<string>),
          ...(incoming["agentMessageIds"] as Array<string>),
        ]),
      ];
    }
  }

  private tool(c: LooseChunk, patch: Record<string, unknown>) {
    const toolCallId = String(c["toolCallId"]);
    let part = this.toolParts.get(toolCallId);
    if (part === undefined) {
      const dynamic = c["dynamic"] === true;
      part = {
        type: dynamic ? "dynamic-tool" : `tool-${String(c["toolName"])}`,
        ...(dynamic ? { toolName: c["toolName"] } : {}),
        toolCallId,
      };
      this.parts.push(part);
      this.toolParts.set(toolCallId, part);
    }
    Object.assign(part, pick(c, "providerExecuted", "title", "toolMetadata"), patch);
    if (part.type === "dynamic-tool" && c["toolName"] !== undefined) {
      part["toolName"] = c["toolName"];
    }
    if (patch["state"] === "input-available" || patch["state"] === "output-error") {
      Object.assign(part, pick(c, "providerMetadata"));
    }
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete part[key];
  }
}

const pick = (c: LooseChunk, ...keys: ReadonlyArray<string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (c[key] !== undefined) out[key] = c[key];
  return out;
};
