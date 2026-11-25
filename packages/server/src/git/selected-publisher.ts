import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { materializeSelectedPublisher } from "./local-checks.ts";

type Args = [string, string, string, string, string, string];
const isArgs = (args: string[]): args is Args => args.length === 6;

const args = process.argv.slice(2);
if (!isArgs(args))
  throw new Error("expected publisher, manifest, manifest SHA256, head, base and tree");
const [dir, manifest, sha256, head, base, tree] = args;
const prepared = await Effect.runPromise(
  materializeSelectedPublisher(dir, { manifest, sha256 }, head, base, tree).pipe(
    Effect.provide(ProcLive),
  ),
);
process.stdout.write(JSON.stringify(prepared) + "\n");
