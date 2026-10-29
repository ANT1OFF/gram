/** Native selected-store preparation; never checks, posts or materializes source. */
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { prepareSelectedPrivatePublisher } from "./local-checks.ts";

const args = process.argv.slice(2);
if (args.length !== 8) throw new Error("expected source, store, publisher, manifest, digest, head, base and tree");
const [source, store, publisher, manifest, sha256, head, base, tree] = args as [string,string,string,string,string,string,string,string];
const result = await Effect.runPromise(
  prepareSelectedPrivatePublisher(source, store, publisher, head, base, tree, { manifest, sha256 }).pipe(Effect.provide(ProcLive)),
);
process.stdout.write(JSON.stringify(result) + "\n");
