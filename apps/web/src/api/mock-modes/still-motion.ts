import { MotionGlobalConfig } from "motion/react";

if (import.meta.env.VITE_API === "mock" && import.meta.env.VITE_MOCK_DETERMINISTIC === "1") {
  MotionGlobalConfig.skipAnimations = true;
  MotionGlobalConfig.instantAnimations = true;
}
