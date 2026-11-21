// Bombadil's exploration of the mock under its fault profile (`--faults <rate>`; see
// docs/VERIFICATION.md#random-exploration-trial): that share of the app's api calls is slowed or
// fails as a server or a socket would (src/api/mock-modes/faults.ts). These properties say the app
// stays usable through it: it never sits without a control, never throws, says when something the
// person asked for failed, and a retry it offers can be pressed. Console errors are expected here,
// so `noConsoleErrors` is left out; the rest of spec.ts's properties still hold and are kept.
import { actions, always, eventually, next, weighted } from "@antithesishq/bombadil";
import { extract, type ActionTemplate } from "@antithesishq/bombadil/browser";

export { defaultActions } from "@antithesishq/bombadil/browser/defaults";
export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";
export {
  backLeavesThePage,
  inboxCountAgrees,
  noUnrenderedValues,
  oneEntryPerClick,
} from "./spec.ts";

interface Fault {
  readonly seq: number;
  readonly method: string;
  readonly kind: "slow" | "server" | "network" | "timeout";
  readonly asked: boolean;
  readonly write: boolean;
}

interface Page {
  gramMockFaults?: Fault[];
  gramMockClock?: { inputs(): number };
}

// --- Never left without a control -------------------------------------------------------------
// Failed boot calls are retried, so the app draws something to press within a while. Until it
// has, and until the first input in the replayable mock, the explorer waits and now and then
// reloads: a replay whose first look comes before or after the app draws then matches either.

const drawn = extract((state) => state.document.querySelector("button, a[href]") !== null);
const noInputYet = extract(
  (state) => ((state.window as unknown as Page).gramMockClock?.inputs() ?? 1) === 0,
);

export const waitForTheApp = weighted<ActionTemplate>([
  [9, actions((): ActionTemplate[] => ["Wait"])],
  [1, actions((): ActionTemplate[] => ["Reload"])],
]).when(() => !drawn.current || noInputYet.current);

export const neverBlank = always(eventually(() => drawn.current).within(15, "seconds"));

// --- A change the person asked for that fails is shown ----------------------------------------
// A call that changes something (`write` in src/api/mock-modes/faults.ts) and failed within a
// second of a press or a key is one the person is waiting on: within a few seconds the page says
// so, in the failure's own words or as an error. A read may fail quietly and be retried.

const SHOWN =
  /had a problem \(503|Lost the connection to the Gram server|didn't answer in time|Something went wrong|Couldn['’]t|Could not/i;

const failure = extract((state) => {
  const faults = (state.window as unknown as Page).gramMockFaults ?? [];
  for (let index = faults.length - 1; index >= 0; index--) {
    const fault = faults[index]!;
    if (fault.kind !== "slow" && fault.asked && fault.write)
      return { seq: fault.seq, method: fault.method };
  }
  return null;
});

const errorShown = extract((state) => {
  const body = state.document.body;
  if (!body) return false;
  if (SHOWN.test(body.innerText)) return true;
  return [...state.document.querySelectorAll('[role="alert"]')].some(
    (element) => (element as HTMLElement).innerText.trim() !== "",
  );
});

export const askedForFailuresAreShown = always(() => {
  const before = failure.current?.seq ?? 0;
  return next(() => {
    const after = failure.current;
    if (after === null || after.seq === before) return true;
    return eventually(() => errorShown.current).within(5, "seconds");
  });
});

// --- A retry it offers can be pressed ---------------------------------------------------------
// "Retry", "Try again" or "Reconnect" on screen is enabled within a few seconds: a way back that
// stays greyed out is no way back. The explorer's clicks press it like any other control.

const RETRY = /^(Retry( now)?|Try again|Reconnect)$/;

const retry = extract((state) => {
  for (const button of state.document.querySelectorAll("button")) {
    if (!RETRY.test((button.textContent ?? "").trim())) continue;
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    return { label: (button.textContent ?? "").trim(), disabled: button.disabled };
  }
  return null;
});

export const retriesCanBePressed = always(() => {
  const shown = retry.current;
  if (shown === null || !shown.disabled) return true;
  return eventually(() => retry.current === null || !retry.current.disabled).within(5, "seconds");
});
