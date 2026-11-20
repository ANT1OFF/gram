interface ImportMetaEnv {
  /** `rpc` (default) connects to the server over `/ws`; `mock` runs the in-memory api. */
  readonly VITE_API?: "mock" | "rpc";
  /** Mock script speed multiplier; `0` for tests. */
  readonly VITE_MOCK_SPEED?: string;
  /** `1`: the replayable mock, on a seeded random and a step clock (`api/mock-modes`). */
  readonly VITE_MOCK_DETERMINISTIC?: string;
  /** The replayable mock's seed, a non-negative integer (default 1). */
  readonly VITE_MOCK_SEED?: string;
  /** A rate in (0, 1]: that share of mock api calls is slowed or fails (`api/mock-modes/faults`). */
  readonly VITE_MOCK_FAULTS?: string;
  /** The fault profile's own seed, a non-negative integer (default 1). */
  readonly VITE_MOCK_FAULT_SEED?: string;
}
