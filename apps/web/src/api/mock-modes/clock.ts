const MIN_DELAY_MS = 1;
const TURNS_BETWEEN_TIMERS = 32;

interface Timer {
  readonly id: number;
  due: number;
  readonly order: number;
  readonly run: () => void;
  readonly every: number | undefined;
}

export interface ClockState {
  /** Virtual time now, in epoch milliseconds. */
  readonly now: number;
  /** How far timers may run: `now` plus what inputs have granted and not yet been spent. */
  readonly until: number;
}

export class MockClock {
  readonly stepMs: number;
  #now: number;
  #until: number;
  readonly #timers = new Map<number, Timer>();
  #nextId = 1;
  #order = 0;
  #pumping = false;
  #pumpQueued = false;
  readonly #onError: (error: unknown) => void;

  constructor(start: ClockState, stepMs: number, onError: (error: unknown) => void) {
    this.#now = start.now;
    this.#until = start.until;
    this.stepMs = stepMs;
    this.#onError = onError;
  }

  now(): number {
    return this.#now;
  }

  state(): ClockState {
    return { now: this.#now, until: this.#until };
  }

  /** Timers waiting, for a person looking at `window.gramMockClock` in the console. */
  pending(): number {
    return this.#timers.size;
  }

  setTimer(run: () => void, delay: unknown, repeat: boolean): number {
    const ms = Math.max(MIN_DELAY_MS, Number(delay) || 0);
    const id = this.#nextId++;
    this.#timers.set(id, {
      id,
      due: this.#now + ms,
      order: this.#order++,
      run,
      every: repeat ? ms : undefined,
    });
    this.#queuePump();
    return id;
  }

  clearTimer(id: unknown): void {
    if (typeof id === "number") this.#timers.delete(id);
  }

  /** Nothing due within what has been granted, and nothing running: the step has settled. */
  idle(): boolean {
    return !this.#pumping && !this.#pumpQueued && this.#nextDue() === undefined;
  }

  /** One input's worth of time: what is due within it fires before the page's next task. */
  step(): void {
    this.#until = Math.max(this.#until, this.#now) + this.stepMs;
    this.#queuePump();
  }

  /** Runs what is due now, for tests; the page relies on the queued pump. */
  async settle(): Promise<void> {
    await this.#pump();
  }

  #queuePump() {
    if (this.#pumpQueued || this.#pumping) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      void this.#pump();
    });
  }

  #nextDue(): Timer | undefined {
    let next: Timer | undefined;
    for (const timer of this.#timers.values()) {
      if (timer.due > this.#until) continue;
      if (!next || timer.due < next.due || (timer.due === next.due && timer.order < next.order))
        next = timer;
    }
    return next;
  }

  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let timer = this.#nextDue(); timer; timer = this.#nextDue()) {
        this.#now = Math.max(this.#now, timer.due);
        if (timer.every === undefined) this.#timers.delete(timer.id);
        else timer.due += timer.every;
        try {
          timer.run();
        } catch (error) {
          this.#onError(error);
        }
        for (let turn = 0; turn < TURNS_BETWEEN_TIMERS; turn++) await Promise.resolve();
      }
    } finally {
      this.#pumping = false;
    }
  }
}
