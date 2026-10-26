export { codexHelperFixture } from "./helper-fixture.ts";
import { readFileSync } from "node:fs";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";

const FIXTURES = new URL("../../fixtures/codex/", import.meta.url);

export interface CodexFixtureMessage {
  /** `out`: what the recorder sent; `in`: what app-server sent. */
  readonly dir: "in" | "out";
  readonly msg: Readonly<Record<string, unknown>>;
}

export interface CodexFixture {
  readonly scenario: string;
  readonly cliVersion: string;
  readonly messages: ReadonlyArray<CodexFixtureMessage>;
}

/** A recorded `codex app-server` stream from `scripts/record-codex.mjs`. */
export const codexFixture = (name: string): CodexFixture =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as CodexFixture;

/** The server's notifications and requests in arrival order, without responses. */
export const serverMessages = (fixture: CodexFixture): Array<ServerNotification | ServerRequest> =>
  fixture.messages
    .filter((m) => m.dir === "in" && typeof m.msg["method"] === "string")
    .map((m) => m.msg as unknown as ServerNotification | ServerRequest);
