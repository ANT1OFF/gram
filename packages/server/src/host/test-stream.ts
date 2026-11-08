import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

/** Two ends of one local stream: the host's and the control plane's. */
export const streamPair = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ host: NetSocket; control: NetSocket; dir: string }>(
        (resolve, reject) => {
          const dir = mkdtempSync(join(tmpdir(), "gram-host-protocol-"));
          const path = join(dir, "s");
          const server = createServer((host) => {
            server.close();
            resolve({ host, control, dir });
          });
          server.once("error", reject);
          let control: NetSocket;
          server.listen(path, () => {
            control = connect(path);
          });
        },
      ),
  ),
  ({ host, control, dir }) =>
    Effect.sync(() => {
      host.destroy();
      control.destroy();
      rmSync(dir, { recursive: true, force: true });
    }),
);
