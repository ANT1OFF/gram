// Motion's animations, skipped in the replayable mock's build: they run on frame time, which the
// step clock doesn't hold. Separate from `install.ts`, which must not import a package (see there).
import { MotionGlobalConfig } from "motion/react";

if (import.meta.env.VITE_API === "mock" && import.meta.env.VITE_MOCK_DETERMINISTIC === "1") {
  MotionGlobalConfig.skipAnimations = true;
  MotionGlobalConfig.instantAnimations = true;
}
