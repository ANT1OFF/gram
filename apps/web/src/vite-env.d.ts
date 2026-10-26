import type { DesktopBridge } from "@gram/contracts";

import type { MockControls } from "./api/mock";
import type { Api } from "./api/types";

declare global {
  interface Window {
    /** Present only inside the desktop shell. */
    readonly gram?: DesktopBridge;
    /** The in-memory API with `VITE_API=mock`, and its e2e hooks such as `simulateChecks`. */
    gramMock?: Api & MockControls;
    /** Set by an e2e spec before the app loads: scripted gates wait for `gramMock.release`. */
    gramMockHoldGates?: boolean;
  }
}
