import { MockClock, type ClockState } from "./clock";
import { deriveSeed, parseSeed, seeded } from "./prng";

let realNow: () => number = () => 0;
const QUIET_MS = 60;
const LOOK_CAP_MS = 3000;

/** Where virtual time starts: a fixed Thursday morning, so dates the mock shows don't drift. */
export const MOCK_EPOCH = Date.UTC(2026, 0, 15, 9, 0, 0);
/** Virtual time one input grants: long enough for a mock reply to stream at e2e speed. */
export const STEP_MS = 1000;
export const DEFAULT_SEED = 1;
const IDLE_MS = 50;

const STORAGE_KEY = "gram.mock-determinism";

interface Stored extends ClockState {
  readonly loads: number;
  readonly inputs: number;
}

function readStored(): Stored | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<Stored>;
    if (
      typeof value.now === "number" &&
      typeof value.until === "number" &&
      typeof value.loads === "number" &&
      typeof value.inputs === "number"
    )
      return { now: value.now, until: value.until, loads: value.loads, inputs: value.inputs };
  } catch (_noStorageOrNotOursStartFresh) {}
  return undefined;
}

function writeStored(value: Stored) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (_storageRefusedAReloadThenStartsTheClockAgain) {}
}

function installRandom(random: () => number) {
  Math.random = random;
  const bytes = <T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array;
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let index = 0; index < view.length; index++) view[index] = Math.floor(random() * 256);
    return array;
  };
  const uuid = () => {
    const b = bytes(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as const;
  };
  Object.defineProperty(crypto, "getRandomValues", { value: bytes, configurable: true });
  Object.defineProperty(crypto, "randomUUID", { value: uuid, configurable: true });
}

function installDate(clock: MockClock) {
  const RealDate = Date;
  function MockDate(this: unknown, ...args: unknown[]) {
    if (new.target === undefined) return new RealDate(clock.now()).toString();
    // oxlint-disable-next-line typescript/no-unsafe-return -- a Date stand-in constructs the real one for `new.target`
    return Reflect.construct(RealDate, args.length === 0 ? [clock.now()] : args, new.target);
  }
  Object.setPrototypeOf(MockDate, RealDate);
  Object.defineProperty(MockDate, "prototype", { value: RealDate.prototype });
  Object.defineProperty(MockDate, "now", { value: () => clock.now(), configurable: true });
  globalThis.Date = MockDate as unknown as DateConstructor;

  const base = realNow() - (clock.now() - MOCK_EPOCH);
  Object.defineProperty(performance, "now", {
    value: () => base + (clock.now() - MOCK_EPOCH),
    configurable: true,
  });
}

function installTimers(clock: MockClock) {
  const timer =
    (repeat: boolean) =>
    (handler: TimerHandler, delay?: number, ...args: unknown[]): number =>
      typeof handler === "function"
        ? clock.setTimer(() => (handler as (...a: unknown[]) => void)(...args), delay, repeat)
        : 0;
  const clear = (id?: number) => clock.clearTimer(id);
  const idle = (callback: IdleRequestCallback) =>
    clock.setTimer(
      () => callback({ didTimeout: false, timeRemaining: () => IDLE_MS }),
      IDLE_MS,
      false,
    );
  Object.assign(globalThis, {
    setTimeout: timer(false),
    setInterval: timer(true),
    clearTimeout: clear,
    clearInterval: clear,
    requestIdleCallback: idle,
    cancelIdleCallback: clear,
  });
}

const STEP_EVENTS = ["pointerdown", "keydown", "wheel", "popstate"] as const;

function installSteps(clock: MockClock, mark: Mark) {
  const save = () => writeStored({ ...clock.state(), loads: mark.loads, inputs: mark.inputs });
  for (const type of STEP_EVENTS)
    window.addEventListener(
      type,
      () => {
        mark.inputs++;
        clock.step();
        save();
      },
      { capture: true, passive: true },
    );
  window.addEventListener("pagehide", save);
  save();
}

interface Mark {
  readonly loads: number;
  inputs: number;
}

const STILL_CSS = `*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}`;

function installStillness() {
  const style = document.createElement("style");
  style.dataset["gramMock"] = "still";
  style.textContent = STILL_CSS;
  document.head.append(style);

  const realMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    const list = realMatchMedia(query);
    if (!/prefers-reduced-motion\s*:\s*reduce/.test(query)) return list;
    return Object.defineProperty(list, "matches", { value: true, configurable: true });
  };
}

function fromPage(): boolean {
  const frames = (new Error().stack ?? "").split("\n").slice(3);
  return frames.some((frame) => /\bhttps?:\/\//.test(frame));
}

const drawn = () => document.querySelector("#root button, #root a[href]") !== null;

function installSettledLooks(clock: MockClock) {
  let lastChange = realNow();
  new MutationObserver(() => {
    lastChange = realNow();
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const settled = () => drawn() && clock.idle() && realNow() - lastChange >= QUIET_MS;

  const realFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    if (fromPage()) return realFrame(callback);
    const asked = realNow();
    const look: FrameRequestCallback = (time) => {
      if (settled() || realNow() - asked >= LOOK_CAP_MS) callback(time);
      else realFrame(look);
    };
    return realFrame(look);
  };
}

declare global {
  interface Window {
    gramMockClock?: {
      readonly clock: MockClock;
      readonly seed: number;
      readonly loads: number;
      readonly inputs: () => number;
    };
  }
}

export function installDeterminism(env: { seed?: string | undefined }) {
  realNow = performance.now.bind(performance);
  const seed = parseSeed(env.seed, DEFAULT_SEED);
  const stored = readStored();
  const mark: Mark = { loads: (stored?.loads ?? -1) + 1, inputs: stored?.inputs ?? 0 };
  const clock = new MockClock(stored ?? { now: MOCK_EPOCH, until: MOCK_EPOCH }, STEP_MS, (error) =>
    reportError(error),
  );
  installRandom(seeded(deriveSeed(seed, mark.loads)));
  installDate(clock);
  installTimers(clock);
  installStillness();
  installSteps(clock, mark);
  installSettledLooks(clock);
  clock.step();
  window.gramMockClock = { clock, seed, loads: mark.loads, inputs: () => mark.inputs };
  console.info(`gram: replayable mock, seed ${seed}, load ${mark.loads}`);
}
