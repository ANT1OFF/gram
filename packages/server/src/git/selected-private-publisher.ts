import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { prepareSelectedPrivatePublisher } from "./local-checks.ts";

type Args = [string, string, string, string, string, string, string, string];
const isArgs = (args: string[]): args is Args => args.length === 8;

const args = process.argv.slice(2);
if (!isArgs(args))
  throw new Error("expected source, store, publisher, manifest, digest, head, base and tree");
const [source, store, publisher, manifest, sha256, head, base, tree] = args;
const result = await Effect.runPromise(
  prepareSelectedPrivatePublisher(source, store, publisher, head, base, tree, {
    manifest,
    sha256,
  }).pipe(Effect.provide(ProcLive)),
);
process.stdout.write(JSON.stringify(result) + "\n");
