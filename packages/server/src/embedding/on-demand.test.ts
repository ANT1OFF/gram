import type { HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  headlessPlacement,
  machineFor,
  NO_MACHINE_JOINED,
  NOT_YOUR_MACHINE,
  placeRequest,
  START_A_MACHINE,
  type PlaceableMachine,
} from "../host/headless.ts";
import { embedFromEnv, scrubEmbedSecrets } from "./config.ts";
import { makeOnDemandHosts, ownMachine, parseStart, statusFor, takeProgress } from "./on-demand.ts";
import { ActingPerson } from "./person.ts";

const id = (value: string) => value as HostId;
const TOKEN = "t".repeat(40);
const machine = (
  over: Omit<Partial<PlaceableMachine>, "id"> & { id: string },
): PlaceableMachine => ({
  name: over.id,
  confirmed: true,
  joinedAt: 1,
  onlineSince: 10,
  ...over,
  id: id(over.id),
});

describe("hosts provisioned on demand: placement", () => {
  const ada = machine({ id: "m-ada", owner: "ada", onDemand: "personal" });
  const grace = machine({ id: "m-grace", owner: "grace", onDemand: "personal" });
  const shared = machine({ id: "m-shared", joinedAt: 5 });

  it("places a person's work on their own machine, and never on another person's", () => {
    expect(machineFor([grace, ada, shared], "ada", true)).toEqual({ id: "m-ada" });
    expect(machineFor([grace, shared], "ada", true)).toEqual({ id: "m-shared" });
    // Someone else's machine is nobody's default.
    expect(machineFor([grace], "ada", true)).toEqual({ error: START_A_MACHINE });
    expect(machineFor([grace], undefined, true)).toEqual({ error: NO_MACHINE_JOINED });
  });

  it("tells a person to start one only where hosts are provisioned on demand", () => {
    expect(machineFor([], "ada", true)).toEqual({ error: START_A_MACHINE });
    expect(machineFor([], "ada", false)).toEqual({ error: NO_MACHINE_JOINED });
  });

  it("skips a person's machine that is offline, or a thread's host", () => {
    const offline = machine({
      id: "m-off",
      owner: "ada",
      onDemand: "personal",
      onlineSince: undefined,
    });
    const thread = machine({ id: "m-thread", owner: "ada", onDemand: "thread" });
    expect(machineFor([offline, thread], "ada", true)).toEqual({ error: START_A_MACHINE });
  });

  it("refuses work that names another person's machine", async () => {
    const placement = headlessPlacement({ list: () => [ada, grace, shared] as never }, true);
    const place = (person: string | undefined, hostId: string) =>
      Effect.runPromise(
        placeRequest(placement, { kind: "newWorktree", hostId: id(hostId) } as never).pipe(
          Effect.provideService(ActingPerson, person),
          Effect.match({ onFailure: (error) => error.message, onSuccess: () => "placed" }),
        ),
      );
    expect(await place("ada", "m-ada")).toBe("placed");
    expect(await place("ada", "m-grace")).toBe(NOT_YOUR_MACHINE);
    expect(await place(undefined, "m-grace")).toBe(NOT_YOUR_MACHINE);
    expect(await place("ada", "m-shared")).toBe("placed");
  });
});

describe("hosts provisioned on demand: requests and progress", () => {
  it("takes a short list of repositories, or none", () => {
    expect(parseStart("")).toEqual({ repositories: [] });
    expect(parseStart('{"repositories":["acme/web","acme/web","acme/api"]}')).toEqual({
      repositories: ["acme/web", "acme/api"],
    });
    expect(parseStart('{"repositories":["../etc"]}')).toEqual(expect.any(String));
    expect(parseStart('{"repositories":["acme/.."]}')).toEqual(expect.any(String));
    expect(parseStart('{"repositories":"acme/web"}')).toEqual(expect.any(String));
    expect(parseStart("[]")).toEqual(expect.any(String));
    expect(parseStart("{")).toEqual(expect.any(String));
  });

  it("shows a person their own machine and progress, and no one else's", () => {
    const hosts = makeOnDemandHosts({ url: "https://provider.test" });
    const machines = [
      { id: "m-ada", name: "ada-1", owner: "ada", onDemand: "personal" as const, onlineSince: 5 },
      { id: "m-grace", name: "grace-1", owner: "grace", onDemand: "personal" as const },
    ];
    expect(ownMachine(machines, "ada")?.id).toBe("m-ada");
    expect(statusFor(hosts, machines, "ada")).toEqual({
      available: true,
      machine: { id: "m-ada", name: "ada-1", online: true },
    });
    expect(statusFor(hosts, machines, "someone")).toEqual({ available: true });
  });

  it("takes progress only for a start it asked for, for that person", () => {
    const hosts = makeOnDemandHosts({ url: "https://provider.test" });
    hosts.progress.set("ada", { hostKey: "personal:ws:ada", phase: "starting", at: 1 });
    expect(
      takeProgress(hosts, { owner: "grace", hostKey: "personal:ws:ada", phase: "ready" }, 2).status,
    ).toBe(404);
    expect(takeProgress(hosts, { owner: "ada", hostKey: "other", phase: "ready" }, 2).status).toBe(
      404,
    );
    expect(
      takeProgress(hosts, { owner: "ada", hostKey: "personal:ws:ada", phase: "done" }, 2).status,
    ).toBe(400);
    expect(
      takeProgress(
        hosts,
        {
          owner: "ada",
          hostKey: "personal:ws:ada",
          phase: "booting",
          step: "Disk ready",
          message: "a\nb",
        },
        2,
      ),
    ).toEqual({ status: 200, body: { taken: true } });
    // A line with a newline is not kept; the rest is.
    expect(hosts.progress.get("ada")).toEqual({
      hostKey: "personal:ws:ada",
      phase: "booting",
      step: "Disk ready",
      at: 2,
    });
  });
});

describe("hosts provisioned on demand: configuration", () => {
  it("reads the provider, which needs the inbound token for its progress", () => {
    expect(
      embedFromEnv({
        GRAM_EMBED_TOKEN: TOKEN,
        GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts/",
        GRAM_HOST_PROVIDER_TOKEN: TOKEN,
      })?.hostProvider,
    ).toEqual({ url: "https://cell-manager.internal/hosts", token: TOKEN });
    expect(() =>
      embedFromEnv({ GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts" }),
    ).toThrow(/GRAM_EMBED_TOKEN/);
  });

  it("keeps the provider's token from everything the server starts", () => {
    const env: Record<string, string | undefined> = {
      GRAM_HOST_PROVIDER_TOKEN: TOKEN,
      GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts",
    };
    scrubEmbedSecrets(env);
    expect(env).toEqual({ GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts" });
  });
});
