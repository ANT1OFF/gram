import { describe, expect, it } from "@effect/vitest";
import { WORKSPACE_MACHINE_NOT_RUNNING, type WorkspaceState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpServerRequest } from "../platform/unstable.ts";
import {
  makeOnDemandHosts,
  ON_DEMAND_START_PATH,
  ON_DEMAND_STATUS_PATH,
  onDemandRequest,
  type OwnedMachine,
  takeProgress,
} from "./on-demand.ts";
import { workspaceHost, workspaceMachineName } from "./workspace-machines.ts";

/** A host provider that answers `/hosts/start` with a host key, and keeps what it got. */
const provider = async () => {
  const got: unknown[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      got.push({ path: request.url, body: JSON.parse(text) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ hostKey: "workspace:ws:ada:w-1" }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    hosts: makeOnDemandHosts({ url: `http://127.0.0.1:${port}`, token: "t" }, store),
    got,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
};

const workspace = { id: "w-1", name: "Payments", environment: "env-node" };
const name = workspaceMachineName("ada", "w-1");
const ada = { id: "ada", name: "Ada", role: "member" } as const;
const store = {
  getWorkspace: (id: string) =>
    id === "w-1"
      ? Effect.succeed({ workspace } as unknown as WorkspaceState)
      : id === "w-plain"
        ? Effect.succeed({ workspace: { id, name: "Docs" } } as unknown as WorkspaceState)
        : Effect.fail("not found"),
} as never;
const request = (path: string, body?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
    }),
  );
const answerOf = (response: { body: unknown }) => {
  const body = response.body as { _tag: string; body?: Uint8Array };
  return body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : body;
};

describe("a workspace's own machine", () => {
  it("is one per person and workspace", () => {
    expect(name).toBe(workspaceMachineName("ada", "w-1"));
    expect(name).not.toBe(workspaceMachineName("bob", "w-1"));
    expect(name).not.toBe(workspaceMachineName("ada", "w-2"));
  });

  it.effect("is started as the person asked, with the proxy's proof and its environment", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(provider);
      const body = JSON.stringify({ workspace: "w-1" });
      const started = yield* onDemandRequest(
        fake.hosts,
        () => [],
        request(ON_DEMAND_START_PATH, body),
        ON_DEMAND_START_PATH,
        ada,
        "signed",
      );
      // One with no environment of its own, or none at all, has no machine of its own.
      for (const id of ["w-plain", "w-gone"]) {
        const refused = yield* onDemandRequest(
          fake.hosts,
          () => [],
          request(ON_DEMAND_START_PATH, JSON.stringify({ workspace: id })),
          ON_DEMAND_START_PATH,
          ada,
          "signed",
        );
        expect(refused.status).toBe(404);
      }
      yield* Effect.promise(fake.close);
      expect(started.status).toBe(202);
      expect(fake.got).toEqual([
        {
          path: "/hosts/start",
          body: {
            kind: "workspace",
            owner: "ada",
            name,
            options: {
              workspace: "w-1",
              title: "Payments",
              environment: "env-node",
              repositories: [],
            },
            proof: { statement: "signed", method: "POST", path: ON_DEMAND_START_PATH, body },
          },
        },
      ]);
      // Its progress is its own, beside the person's machine's.
      expect(
        takeProgress(fake.hosts, {
          owner: "ada",
          hostKey: "workspace:ws:ada:w-1",
          phase: "booting",
        }).status,
      ).toBe(404);
      expect(
        takeProgress(fake.hosts, {
          owner: "ada",
          workspace: "w-1",
          hostKey: "workspace:ws:ada:w-1",
          phase: "booting",
        }).status,
      ).toBe(200);
      const status = yield* onDemandRequest(
        fake.hosts,
        () => [],
        request(`${ON_DEMAND_STATUS_PATH}?workspace=w-1`),
        ON_DEMAND_STATUS_PATH,
        ada,
        "signed",
      );
      expect(answerOf(status)).toMatchObject({ available: true, progress: { phase: "booting" } });
    }),
  );

  it.effect("places the orchestrator on it once online, and on no one else's", () =>
    Effect.gen(function* () {
      const machines: OwnedMachine[] = [
        { id: "h-bob", name, owner: "bob", onDemand: "thread", onlineSince: 1 },
        { id: "h-own", name, owner: "ada", onDemand: "personal", onlineSince: 1 },
      ];
      const refused = yield* workspaceHost(true, () => machines, "ada", workspace).pipe(
        Effect.flip,
      );
      expect(refused.message).toContain(WORKSPACE_MACHINE_NOT_RUNNING);
      machines.push({ id: "h-1", name, owner: "ada", onDemand: "thread", onlineSince: 2 });
      expect(yield* workspaceHost(true, () => machines, "ada", workspace)).toBe("h-1");
    }),
  );

  it.effect("goes where the person's work goes with no environment, person or provider", () =>
    Effect.gen(function* () {
      const { environment: _, ...plain } = workspace;
      expect(yield* workspaceHost(true, () => [], "ada", plain)).toBeUndefined();
      expect(yield* workspaceHost(true, () => [], undefined, workspace)).toBeUndefined();
      expect(yield* workspaceHost(false, () => [], "ada", workspace)).toBeUndefined();
    }),
  );
});
