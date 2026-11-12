import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL_OLDEST,
  HOST_PROTOCOL_VERSION,
  HOST_REQUIRED_CAPABILITIES,
  HostRpcs,
} from "./host.ts";
import { describeHostWire, type HostWire, hostWireBreaks, type WireBreak } from "./host-wire.ts";

/**
 * The compatibility rule for joined machines: between releases the host protocol only grows, so a
 * host or a control plane of any release this build still talks to keeps working with it. A joined
 * machine can be several releases behind (it updates when someone asks it to), and a deployment
 * that runs Gram's host pins a release of its own. `host-released/<release>.json` is the protocol as
 * each release spoke it, from 1.19.0, the first recorded, on; the first test fails on any change a
 * release of `HOST_PROTOCOL_OLDEST` or later can't live with. See docs/MACHINES.md, "Machines on
 * different releases".
 *
 * When it fails, change the protocol another way: add a call, an optional field or a feature a host
 * names in its hello, and leave what is there as it is. Where a released build is certain never to
 * meet the change (a value sent only to a peer that named a feature for it), list the break in
 * `ACCEPTED`, under each release it breaks, with that reason. A change no released build can live with is a new
 * `HOST_PROTOCOL_VERSION`, decided on purpose.
 */

const RELEASED = join(import.meta.dirname, "host-released");
const ROOT_PACKAGE = join(import.meta.dirname, "../../../../package.json");

/**
 * Breaks of a released protocol taken on purpose, by release, each with why no build of that
 * release meets it.
 */
const ACCEPTED: Readonly<Record<string, ReadonlyArray<WireBreak & { readonly because: string }>>> =
  {};

interface Released extends HostWire {
  /** The Gram release whose protocol this is. */
  readonly release: string;
}

/** `[major, minor, patch]`. */
const parts = (release: string): Array<number> => release.split(".").map(Number);
const byRelease = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

const current = (): HostWire =>
  describeHostWire(HostRpcs, {
    protocol: HOST_PROTOCOL_VERSION,
    requires: HOST_REQUIRED_CAPABILITIES,
  });

const version = (): string =>
  (JSON.parse(readFileSync(ROOT_PACKAGE, "utf8")) as { version: string }).version;

/** One call a line, so a release's change to the file shows which calls grew. */
const written = (release: string, wire: HostWire): string =>
  [
    "{",
    `"release": ${JSON.stringify(release)},`,
    `"protocol": ${wire.protocol},`,
    `"requires": ${JSON.stringify(wire.requires)},`,
    `"calls": {`,
    Object.entries(wire.calls)
      .map(([tag, call]) => `${JSON.stringify(tag)}: ${JSON.stringify(call)}`)
      .join(",\n"),
    "}",
    "}",
    "",
  ].join("\n");

/** Every recorded release's protocol, oldest first. */
const releases = (): Array<Released> =>
  readdirSync(RELEASED)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(RELEASED, name), "utf8")) as Released)
    .toSorted((a, b) => byRelease(a.release, b.release));

/** The releases this build's control plane still talks to, which it must keep working with. */
const spoken = () => releases().filter((each) => each.protocol >= HOST_PROTOCOL_OLDEST);

const told = (breaks: ReadonlyArray<WireBreak>) => breaks.map((b) => `${b.at}: ${b.what}`);

// `bun run host-protocol:release`, on a release's own pull request: this build's protocol is
// recorded as that release's, beside the earlier ones, which stay as they are.
if (process.env["GRAM_HOST_RELEASED"] === "write") {
  for (const each of spoken()) {
    const breaks = hostWireBreaks(each, current());
    if (breaks.length > (ACCEPTED[each.release]?.length ?? 0))
      throw new Error(`The protocol breaks ${each.release}'s; fix that before recording it.`);
  }
  const file = join(RELEASED, `${version()}.json`);
  if (!existsSync(file)) writeFileSync(file, written(version(), current()));
}

describe("the host protocol as released", () => {
  it.each(spoken().map((each) => [each.release, each] as const))(
    "is still spoken to %s: nothing its host or control plane relies on changed",
    (release, each) => {
      const breaks = told(hostWireBreaks(each, current()));
      const accepted = told(ACCEPTED[release] ?? []);
      expect(breaks.filter((b) => !accepted.includes(b))).toEqual([]);
      // An accepted break that is no longer one is taken off the list.
      expect(accepted.filter((b) => !breaks.includes(b))).toEqual([]);
    },
  );

  it("names only releases it has a recorded protocol for in ACCEPTED", () => {
    const recorded = releases().map((each) => each.release);
    expect(Object.keys(ACCEPTED).filter((release) => !recorded.includes(release))).toEqual([]);
  });

  it("is recorded for every release from the first, ending at this tree's or the one before", () => {
    // `bun run host-protocol:release` on a release's pull request records what that release
    // speaks. This holds the newest to at most one release behind, so a call or field a release
    // added is soon held too, and leaves no minor release out between the first and the newest.
    const recorded = releases();
    expect(recorded[0]?.release).toBe("1.19.0");
    for (const each of recorded) expect(each.release).toMatch(/^\d+\.\d+\.\d+$/);
    for (let i = 1; i < recorded.length; i++) {
      const [wasMajor, wasMinor] = parts(recorded[i - 1]!.release);
      const [major, minor] = parts(recorded[i]!.release);
      const next = major === wasMajor ? minor! - wasMinor! : minor === 0 ? 1 : NaN;
      expect(next, `${recorded[i - 1]!.release} to ${recorded[i]!.release}`).toBeLessThanOrEqual(1);
      expect(next).toBeGreaterThanOrEqual(0);
    }
    const [major, minor] = parts(version());
    const [wasMajor, wasMinor] = parts(recorded.at(-1)!.release);
    expect(wasMajor).toBe(major);
    expect(minor! - wasMinor!).toBeGreaterThanOrEqual(0);
    expect(minor! - wasMinor!).toBeLessThanOrEqual(1);
  });

  it("keeps each release's file named after the release it records", () => {
    for (const name of readdirSync(RELEASED)) {
      const each = JSON.parse(readFileSync(join(RELEASED, name), "utf8")) as Released;
      expect(name).toBe(`${each.release}.json`);
    }
  });

  it("still talks to the newest recorded release", () => {
    expect(releases().at(-1)!.protocol).toBeGreaterThanOrEqual(HOST_PROTOCOL_OLDEST);
    expect(HOST_PROTOCOL_OLDEST).toBeLessThanOrEqual(HOST_PROTOCOL_VERSION);
  });
});

const wire = (...rpcs: ReadonlyArray<Rpc.Any>): HostWire =>
  describeHostWire(RpcGroup.make(...rpcs), { protocol: 2, requires: ["files"] });

describe("what breaks a released peer", () => {
  const Kind = Schema.Literals(["a", "b"]);
  const base = {
    payload: { path: Schema.String, limit: Schema.optionalKey(Schema.Int) },
    success: Schema.Struct({ kind: Kind, size: Schema.Int }),
  };
  const was = wire(Rpc.make("list", base), Rpc.make("watch", { success: Kind, stream: true }));
  const against = (...rpcs: ReadonlyArray<Rpc.Any>) => told(hostWireBreaks(was, wire(...rpcs)));
  const watch = Rpc.make("watch", { success: Kind, stream: true });

  it("lets a protocol grow: a new call, a new optional field either way", () => {
    expect(
      against(
        Rpc.make("list", {
          payload: { ...base.payload, hidden: Schema.optionalKey(Schema.Boolean) },
          success: Schema.Struct({ ...base.success.fields, note: Schema.optionalKey(Kind) }),
        }),
        watch,
        Rpc.make("more", { payload: { id: Schema.String }, success: Schema.String }),
      ),
    ).toEqual([]);
  });

  it("names a removed call and one that changed how it answers", () => {
    expect(against(Rpc.make("watch", { success: Kind }))).toEqual([
      "list: the call was removed",
      "watch: it no longer answers with a stream",
    ]);
  });

  it("names a field that was removed, became required, or is new and required", () => {
    expect(
      against(
        Rpc.make("list", {
          payload: { path: Schema.String, limit: Schema.Int, depth: Schema.Int },
          success: Schema.Struct({ kind: Kind }),
        }),
        watch,
      ),
    ).toEqual([
      "list payload.limit: the field could be left out and is now required",
      "list payload.depth: a new field is required",
      "list success.size: the field was removed",
    ]);
    expect(
      against(
        Rpc.make("list", {
          payload: { path: Schema.optionalKey(Schema.String), limit: base.payload.limit },
          success: base.success,
        }),
        watch,
      ),
    ).toEqual(["list payload.path: the field was always sent and may now be left out"]);
  });

  it("names a value that changed its type, its bounds or the values it takes", () => {
    expect(
      against(
        Rpc.make("list", {
          payload: {
            path: Schema.String.check(Schema.isMaxLength(8)),
            limit: Schema.optionalKey(Schema.String),
          },
          success: Schema.Struct({ kind: Schema.Literals(["a", "c"]), size: Schema.Int }),
        }),
        watch,
      ),
    ).toEqual([
      "list payload.path: its maxLength changed from nothing to 8",
      'list payload.limit: its type changed from "integer" to "string"',
      'list success.kind: it no longer takes "b"',
      'list success.kind: it now also takes "c"',
    ]);
  });

  it("names a shape a choice gained or lost, and an error a call newly fails with", () => {
    const A = Schema.Struct({ kind: Schema.Literal("a") });
    const B = Schema.Struct({ kind: Schema.Literal("b"), at: Schema.Int });
    const C = Schema.Struct({ kind: Schema.Literal("c") });
    class Failed extends Schema.TaggedError<Failed>()("Failed", { message: Schema.String }) {}
    const before = wire(Rpc.make("next", { success: Schema.Union([A, B]) }));
    expect(
      told(
        hostWireBreaks(
          before,
          wire(Rpc.make("next", { success: Schema.Union([B, C]), error: Failed })),
        ),
      ),
    ).toEqual([
      'next success: one of its shapes was removed: kind "a"',
      'next success: it gained a shape: kind "c"',
      'next error: it gained a shape: _tag "Failed"',
    ]);
  });

  it("names a capability a host must newly serve, and a version that moved", () => {
    expect(
      told(hostWireBreaks(was, { ...was, protocol: 3, requires: ["files", "sessions"] })),
    ).toEqual([
      "protocol: the version went from 2 to 3",
      'requires: a host must now serve "sessions"',
    ]);
  });
});
