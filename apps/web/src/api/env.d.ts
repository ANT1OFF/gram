interface ImportMetaEnv {
  /** `rpc` (default) connects to the server over `/ws`; `mock` runs the in-memory api. */
  readonly VITE_API?: "mock" | "rpc";
  /** Mock script speed multiplier; `0` for tests. */
  readonly VITE_MOCK_SPEED?: string;
}
