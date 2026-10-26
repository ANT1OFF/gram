import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";

const FIXTURES = new URL("../../fixtures/claude/", import.meta.url);

/** The SDK messages the spike recorded, optionally for one labelled query. */
export const fixtureMessages = (name: string, label?: string): Array<SDKMessage> =>
  readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { label?: string; msg?: SDKMessage })
    .filter((entry) => entry.msg !== undefined && (label === undefined || entry.label === label))
    .map((entry) => entry.msg as SDKMessage);
