import { expect, test } from "vitest";
import { inheritedServerEnv } from "./server-env.ts";

const env = { GRAM_FAKE_AGENT: "1", GRAM_FAKE_AGENT_REPLY: "echo", PATH: "/usr/bin" };

test("a packaged build ignores the fake agent's variables and keeps the rest", () => {
  expect(inheritedServerEnv(env, { packaged: true, smoke: false })).toEqual({ PATH: "/usr/bin" });
});

test("a packaged --smoke run keeps the fake, as the release's packaged check needs", () => {
  expect(inheritedServerEnv(env, { packaged: true, smoke: true })).toEqual(env);
});

test("an unpackaged build keeps the fake, for dev and e2e", () => {
  expect(inheritedServerEnv(env, { packaged: false, smoke: false })).toEqual(env);
});
