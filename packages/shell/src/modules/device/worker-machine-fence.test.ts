// The app's fence between a stop and a start of one worker machine name, through the app's own
// call path (`hostedWorkerMachines`): a fake sign-in and a fake server, no network.

import type { HostedDiscovery } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";
import type { TokenKeeper } from "./hosted.ts";
import { hostedWorkerMachines } from "./hosted-worker-machines.ts";
import { devicePrivateKeyFrom, generateDeviceKey } from "./keys.ts";
import { STOP_TOO_LATE, SUPERSEDED } from "./worker-machine-fence.ts";

const ORIGIN = "https://hosted.example.test";
const NAME = "worker-0123456789";
const key = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
const discovery = {
  name: "Example hosted",
  worker_machines_endpoint: `${ORIGIN}/workers`,
  worker_machine_connect: `${ORIGIN.replace("https", "wss")}/workers/relay`,
} as unknown as HostedDiscovery;

/**
 * The app's calls over one signed-in server whose token renewal waits on `renewed`, and whose
 * answers wait on `answer`, recording each request as it goes out.
 */
const setup = (gates: { renewed?: Promise<void>; answer?: Promise<void> } = {}) => {
  const sent: string[] = [];
  const keeper = {
    subject: "ada",
    token: async () => {
      await gates.renewed;
      return {
        ok: true as const,
        token: { accessToken: "at", tokenType: "DPoP" as const, expiresAt: 0, subject: "ada" },
      };
    },
    nonce: {},
    signedOut: () => false,
  } as unknown as TokenKeeper;
  const fetch = async (url: string | URL | Request) => {
    sent.push(String(url).split("/").at(-1) ?? "");
    await gates.answer;
    return new Response(JSON.stringify({ stopped: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const server = { origin: ORIGIN, discovery, key, keeper, limits: { paused: () => false } };
  const machines = hostedWorkerMachines({
    servers: () => [server],
    known: (origin) => (origin === ORIGIN ? server : undefined),
    callsOf: () => ({ discovery, keeper, key, fetch: fetch as typeof globalThis.fetch }),
  });
  return { machines, sent };
};

const waitFor = (done: () => boolean) => vi.waitUntil(done, { timeout: 2_000, interval: 2 });

describe("a worker machine's stop, as the app sends it", () => {
  it("is dropped when a newer start of its name comes while it waits to go out", async () => {
    let renew!: () => void;
    const renewed = new Promise<void>((done) => (renew = done));
    const { machines, sent } = setup({ renewed });
    // The stop waits behind a slow token renewal; the server's hold for it runs out meanwhile,
    // and a retry's start of the same name comes.
    const stopping = machines.workerMachineCall(ORIGIN, "stop", { name: NAME });
    const starting = machines.workerMachineCall(ORIGIN, "start", { name: NAME });
    renew();
    expect(await stopping).toEqual({ ok: false, why: SUPERSEDED });
    expect((await starting).ok).toBe(true);
    // Only the start reached the server: the stop never lands on the retry's machine.
    expect(sent).toEqual(["start"]);
  });

  it("holds a start of its name back while it is on its way", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((done) => (answer = done));
    const { machines, sent } = setup({ answer: answered });
    const stopping = machines.workerMachineCall(ORIGIN, "stop", { name: NAME });
    await waitFor(() => sent.includes("stop"));
    let started = false;
    const starting = machines
      .workerMachineCall(ORIGIN, "start", { name: NAME })
      .then(() => (started = true));
    // Nothing but the stop's answer lets it go: however long it waits, it stays back.
    for (let each = 0; each < 50; each += 1) await Promise.resolve();
    expect(sent).toEqual(["stop"]);
    expect(started).toBe(false);
    answer();
    await stopping;
    await starting;
    expect(sent).toEqual(["stop", "start"]);
  });

  it("is never sent past its sendBy, however long it waited", async () => {
    const { machines, sent } = setup();
    expect(
      await machines.workerMachineCall(ORIGIN, "stop", { name: NAME }, Date.now() - 1),
    ).toEqual({ ok: false, why: STOP_TOO_LATE });
    expect(sent).toEqual([]);
  });
});
