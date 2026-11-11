import { readFileSync, writeFileSync } from "node:fs";
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
 * host or a control plane of the last release keeps working with this build. `host-released.json`
 * is the protocol as that release spoke it, and the first test fails on any change that release
 * can't live with. See docs/MACHINES.md, "Machines on different releases".
 *
 * When it fails, change the protocol another way: add a call, an optional field or a feature a host
 * names in its hello, and leave what is there as it is. Where a released build is certain never to
 * meet the change (a value sent only to a peer that named a feature for it), list the break in
 * `ACCEPTED` with that reason. A change no released build can live with is a new
 * `HOST_PROTOCOL_VERSION`, decided on purpose.
 */

const RELEASED = join(import.meta.dirname, "host-released.json");
const ROOT_PACKAGE = join(import.meta.dirname, "../../../../package.json");

/** Breaks of the released protocol taken on purpose, each with why no released build meets it. */
const ACCEPTED: ReadonlyArray<WireBreak & { readonly because: string }> = [];

interface Released extends HostWire {
  /** The Gram release whose protocol this is. */
  readonly release: string;
}

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

const released = (): Released => JSON.parse(readFileSync(RELEASED, "utf8")) as Released;

// `bun run host-protocol:release`, on a release's own pull request: this build becomes the
// released protocol. Empty `ACCEPTED` with it.
if (process.env["GRAM_HOST_RELEASED"] === "write") {
  const breaks = hostWireBreaks(released(), current());
  if (breaks.length > ACCEPTED.length)
    throw new Error("The protocol breaks the last release's; fix that before recording it.");
  writeFileSync(RELEASED, written(version(), current()));
}

const told = (breaks: ReadonlyArray<WireBreak>) => breaks.map((b) => `${b.at}: ${b.what}`);

describe("the host protocol as last released", () => {
  it("is still spoken: nothing a released host or control plane relies on changed", () => {
    const breaks = told(hostWireBreaks(released(), current()));
    const accepted = told(ACCEPTED);
    expect(breaks.filter((b) => !accepted.includes(b))).toEqual([]);
    // An accepted break that is no longer one is taken off the list.
    expect(accepted.filter((b) => !breaks.includes(b))).toEqual([]);
  });

  it("is the protocol of this tree's release or the one before it", () => {
    // `bun run host-protocol:release` on a release's pull request records what that release
    // speaks. This holds it to at most one release behind, so a call or field a release added is
    // soon held too.
    const [major, minor] = version().split(".").map(Number);
    const [wasMajor, wasMinor] = released().release.split(".").map(Number);
    expect(wasMajor).toBe(major);
    expect(minor! - wasMinor!).toBeGreaterThanOrEqual(0);
    expect(minor! - wasMinor!).toBeLessThanOrEqual(1);
  });

  it("is of a version this build's control plane still talks to", () => {
    expect(released().protocol).toBeGreaterThanOrEqual(HOST_PROTOCOL_OLDEST);
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
