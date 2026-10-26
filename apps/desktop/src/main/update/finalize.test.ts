import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateFinalizer, createUpdateModelScope, finalizeUpdateNative } from "./finalize.ts";
afterEach(() => vi.useRealTimers());
describe("update-specific native completion", () => {
  it("requires native scopes and checked window persistence before permitting arm", async () => {
    const events: string[] = [];
    await finalizeUpdateNative(
      {
        speech: async () => {
          events.push("speech zero EXIT");
        },
        models: async () => {
          events.push("scope complete");
        },
        windows: () => {
          events.push("window write complete");
        },
      },
      new AbortController().signal,
    );
    events.push("arm permitted");
    expect(events).toEqual([
      "speech zero EXIT",
      "scope complete",
      "window write complete",
      "arm permitted",
    ]);
  });
  it.each(["speech", "models", "windows"])(
    "refuses %s failure without authorizing an arm",
    async (step) => {
      let armed = false;
      const fail = () => {
        throw new Error(`invented ${step} error`);
      };
      await expect(
        finalizeUpdateNative(
          {
            speech: step === "speech" ? async () => fail() : async () => {},
            models: step === "models" ? async () => fail() : async () => {},
            windows: step === "windows" ? fail : () => {},
          },
          new AbortController().signal,
        ).then(() => {
          armed = true;
        }),
      ).rejects.toThrow("invented");
      expect(armed).toBe(false);
    },
  );
  it("retains actual 3000 ms native deadline, and a late scope completion cannot authorize an arm", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    let armed = false;
    const pending = finalizeUpdateNative(
      {
        speech: async () => {},
        models: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
        windows: () => {},
      },
      new AbortController().signal,
    ).then(() => {
      armed = true;
    });
    const failure = expect(pending).rejects.toThrow("3000 ms");
    await vi.advanceTimersByTimeAsync(2999);
    expect(armed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    complete();
    await Promise.resolve();
    expect(armed).toBe(false);
  });
  it("user force becomes cancellation and keeps quit serialized through restoration", async () => {
    // The order the signed updater's transaction and recovery use (`createSignedUpdates`).
    const events: string[] = [];
    const finalizer = createUpdateFinalizer();
    await expect(
      finalizer.run(async (signal) => {
        const native = finalizeUpdateNative(
          { speech: () => new Promise(() => {}), models: async () => {}, windows: () => {} },
          signal,
        );
        finalizer.cancel();
        await native;
        events.push("armed");
      }),
    ).rejects.toThrow("cancelled");
    expect(finalizer.active()).toBe(true);
    await expect(finalizer.run(async () => {})).rejects.toThrow("already active");
    await finalizer.settle();
    events.push("restore native", "window reload");
    expect(finalizer.active()).toBe(true);
    finalizer.recovered();
    expect(events).toEqual(["restore native", "window reload"]);
    expect(finalizer.active()).toBe(false);
  });

  it("holds the transaction while an owned shutdown step is still settling", async () => {
    const finalizer = createUpdateFinalizer();
    let finish!: () => void;
    await expect(
      finalizer.run(async () => {
        void finalizer.own(() => new Promise<void>((resolve) => (finish = resolve)));
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    finalizer.recovered();
    expect(finalizer.active()).toBe(true);
    finish();
    await finalizer.settle();
    finalizer.recovered();
    expect(finalizer.active()).toBe(false);
  });
});

describe("native model-scope cancellation recovery", () => {
  it("never opens a replacement while close is pending, and restores only after successful settlement", async () => {
    let complete!: () => void;
    let opened = 0;
    const scope = createUpdateModelScope(async () => {
      opened++;
      return {
        close: () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      };
    });
    await scope.current();
    const closing = scope.close();
    await Promise.resolve();
    const recovery = scope.restore();
    await expect(scope.current()).rejects.toThrow("unavailable");
    expect(opened).toBe(1);
    complete();
    await closing;
    await recovery;
    expect(opened).toBe(2);
    expect(await scope.current()).toHaveProperty("close");
  });
  it("surfaces failed close without silently opening another native scope", async () => {
    let opened = 0;
    const scope = createUpdateModelScope(async () => {
      opened++;
      return {
        close: async () => {
          throw new Error("invented scope failure");
        },
      };
    });
    await expect(scope.close()).rejects.toThrow("scope failure");
    await expect(scope.restore()).rejects.toThrow("close failed");
    await expect(scope.current()).rejects.toThrow("unavailable");
    expect(opened).toBe(1);
  });
  it("bounds replacement open and keeps voice suspended even after late completion", async () => {
    vi.useFakeTimers();
    let opened = 0;
    let complete!: (value: { close(): Promise<void> }) => void;
    const scope = createUpdateModelScope(() => {
      opened++;
      return opened === 1
        ? Promise.resolve({ close: async () => {} })
        : new Promise<{ close(): Promise<void> }>((resolve) => {
            complete = resolve;
          });
    });
    await scope.close();
    const recovery = expect(scope.restore()).rejects.toThrow("3000 ms");
    await vi.advanceTimersByTimeAsync(3000);
    await recovery;
    await expect(scope.current()).rejects.toThrow("unavailable");
    const lateStore = { close: vi.fn(async () => {}) };
    complete(lateStore);
    expect(await scope.owned()).toBe(lateStore);
    await expect(scope.current()).rejects.toThrow("unavailable");
    await scope.close();
    expect(lateStore.close).toHaveBeenCalledOnce();
  });
});
