import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  WakeCondition,
  WakeConditionInput,
  wakeConditionLabel,
  wakeConditionWhen,
} from "./wake-conditions.ts";

const decode = Schema.decodeUnknownSync(WakeCondition);

describe("wake condition words", () => {
  it("says what a stuck-CI wake waits for, and labels its chip", () => {
    const pr = decode({ kind: "ciStuck", repo: "acme/app", pr: 7 });
    expect(wakeConditionWhen(pr)).toBe(
      "a CI job of acme/app#7 sits queued 15+ min, or a run awaits approval",
    );
    expect(wakeConditionLabel(pr)).toBe("CI job queued 15+ min");
    const run = decode({ kind: "ciStuck", repo: "acme/app", runId: 55, queuedMinutes: 30 });
    expect(wakeConditionWhen(run)).toBe(
      "a CI job of acme/app run 55 sits queued 30+ min, or a run awaits approval",
    );
    expect(wakeConditionLabel(run)).toBe("CI job queued 30+ min");
  });

  it("says what a machine wake waits for, and labels its chip", () => {
    const load = decode({ kind: "machine", metric: "load", below: 8 });
    expect(wakeConditionWhen(load)).toBe("this machine's load stays below 8 for 5 min");
    expect(wakeConditionLabel(load)).toBe("quieter (load < 8)");
    const disk = decode({
      kind: "machine",
      metric: "diskFree",
      belowGB: 20,
      path: "/Users/me/code",
    });
    expect(wakeConditionWhen(disk)).toBe("free disk space at /Users/me/code drops below 20 GB");
    expect(wakeConditionLabel(disk)).toBe("disk < 20 GB");
  });

  it("decodes neither a metric it doesn't know nor a metric's fields under the other", () => {
    expect(() => decode({ kind: "machine", metric: "memory", below: 1 })).toThrow();
    expect(() => decode({ kind: "machine", metric: "diskFree", below: 20 })).toThrow();
    expect(() =>
      decode({ kind: "machine", metric: "load", below: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });

  it("names a release wait and its age", () => {
    const codex = decode({
      kind: "releasePublished",
      source: "npm",
      name: "@openai/codex",
      after: "0.166.0",
      minAgeDays: 7,
    });
    expect(wakeConditionLabel(codex)).toBe("codex newer than 0.166.0, 7 days old");
    expect(wakeConditionWhen(codex)).toBe(
      "@openai/codex on npm has a release newer than 0.166.0, at least 7 days old",
    );
    const gh = decode({
      kind: "releasePublished",
      source: "github",
      name: "cli/cli",
      minAgeDays: 0,
      includePrerelease: true,
    });
    expect(wakeConditionLabel(gh)).toBe("cli release");
    expect(wakeConditionWhen(gh)).toBe("cli/cli on GitHub has a new release or prerelease");
  });

  it("names an installed version's change", () => {
    const gram = decode({ kind: "versionChanged", target: "gram", from: "1.5.0" });
    expect(wakeConditionLabel(gram)).toBe("Gram update");
    expect(wakeConditionWhen(gram)).toBe("Gram is updated from 1.5.0");
    const codex = decode({ kind: "versionChanged", target: "codex" });
    expect(wakeConditionLabel(codex)).toBe("Codex update");
    expect(wakeConditionWhen(codex)).toBe("the installed Codex changes");
  });

  it("refuses names and versions that could be read as flags", () => {
    expect(() =>
      decode({ kind: "releasePublished", source: "npm", name: "--registry=evil" }),
    ).toThrow();
    expect(() => decode({ kind: "releasePublished", source: "npm", name: "--registry" })).toThrow();
    expect(() => decode({ kind: "releasePublished", source: "github", name: "-x/y" })).toThrow();
    expect(() => decode({ kind: "versionChanged", target: "gh", from: "latest" })).toThrow();
    expect(() => decode({ kind: "versionChanged", target: "node" })).toThrow();
  });

  it("lists every kind and field of the union in schedule_wake's flat input, and no other", () => {
    const kinds = new Set(WakeCondition.members.map((member) => member.fields.kind.literal));
    expect(new Set(WakeConditionInput.fields.kind.literals)).toEqual(kinds);
    const fields = new Set(WakeCondition.members.flatMap((member) => Object.keys(member.fields)));
    expect(new Set(Object.keys(WakeConditionInput.fields))).toEqual(fields);
  });
});
