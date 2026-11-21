import { installDeterminism } from "./deterministic";

if (import.meta.env.VITE_API === "mock" && import.meta.env.VITE_MOCK_DETERMINISTIC === "1")
  installDeterminism({ seed: import.meta.env.VITE_MOCK_SEED });
