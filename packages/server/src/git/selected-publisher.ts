/** Explicit selected-source preparation; this never runs a check or publishes a result. */
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { materializeSelectedPublisher } from "./local-checks.ts";

const args = process.argv.slice(2);
if (args.length !== 6) throw new Error("expected publisher, manifest, manifest SHA256, head, base and tree");
const [dir, manifest, sha256, head, base, tree] = args as [string, string, string, string, string, string];
const prepared = await Effect.runPromise(
  materializeSelectedPublisher(dir, { manifest, sha256 }, head, base, tree).pipe(Effect.provide(ProcLive)),
);
process.stdout.write(JSON.stringify(prepared) + "\n");
