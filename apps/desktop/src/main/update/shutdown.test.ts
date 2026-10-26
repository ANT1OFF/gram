import { describe, expect, it } from "vitest";
import type { UpdateTeardown } from "@gram/contracts";
import type { StopOutcome, UpdateStopReport } from "../server-host.ts";
import { stopForUpdate, UpdateTeardownRefused } from "./shutdown.ts";

describe("update shutdown refusal", () => {
  it("accepts only completed orderly shutdown", async () => {
    const reasons: string[] = [];
    const stopped: UpdateTeardown[] = [];
    await stopForUpdate(
      {
        stop: async (reason) => {
          reasons.push(reason);
          return "exited";
        },
        updateStop: () => ({ outcome: "exited" }),
      },
      (teardown) => stopped.push(teardown),
    );
    expect(reasons).toEqual(["update"]);
    expect(stopped).toEqual([{ path: "clean" }]);
  });

  it.each<StopOutcome>(["failed", "unconfirmed", "forced", "lingering", "survived", "unverified"])(
    "explains cancellation before replacement after %s",
    async (outcome) => {
      const stopped: UpdateTeardown[] = [];
      const stop = stopForUpdate(
        { stop: async () => outcome, updateStop: () => ({ outcome }) },
        (teardown) => stopped.push(teardown),
      );
      await expect(stop).rejects.toThrow(
        /Update cancelled before app replacement\..*Gram remains on the running version/,
      );
      await expect(stop).rejects.toBeInstanceOf(UpdateTeardownRefused);
      expect(stopped).toEqual([]);
    },
  );

  it.each([
    ["sessions", "Agent sessions did not stop and save their state in time."],
    [
      "agents",
      "An agent process (a Claude Code session or the Codex app-server) did not exit cleanly when stopped.",
    ],
    ["database", "The database could not be closed or sealed with nothing writing to it."],
  ] as const)(
    "names the failed %s essential in the refusal and its receipt",
    async (failed, why) => {
      const report: UpdateStopReport = { outcome: "forced", failed };
      const error = await stopForUpdate({
        stop: async () => "forced",
        updateStop: () => report,
      }).catch((refused: unknown) => refused);
      expect(error).toBeInstanceOf(UpdateTeardownRefused);
      expect((error as UpdateTeardownRefused).message).toContain(`replacement. ${why}`);
      expect((error as UpdateTeardownRefused).teardown).toEqual({
        path: "refused",
        reason: failed,
      });
    },
  );

  it.each([
    ["survived", "survivor"],
    ["unverified", "unverified"],
    ["forced", "teardown"],
    ["unconfirmed", "teardown"],
  ] as const)("records a refused %s stop as %s", async (outcome, reason) => {
    const error = await stopForUpdate({
      stop: async () => outcome,
      updateStop: () => ({ outcome }),
    }).catch((refused: unknown) => refused);
    expect((error as UpdateTeardownRefused).teardown).toEqual({ path: "refused", reason });
  });
});
