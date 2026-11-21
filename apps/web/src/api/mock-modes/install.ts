// The first thing `main.tsx` imports. In the replayable mock's build (`VITE_API=mock` and
// `VITE_MOCK_DETERMINISTIC=1`) it installs the seeded random, the step clock and still motion
// before any other module runs: `vite.config.ts` bundles that build into one file, in which this
// module comes first, so React and its scheduler pick up its timers. In every other build it is
// empty.
import { installDeterminism } from "./deterministic";

if (import.meta.env.VITE_API === "mock" && import.meta.env.VITE_MOCK_DETERMINISTIC === "1")
  installDeterminism({ seed: import.meta.env.VITE_MOCK_SEED });
