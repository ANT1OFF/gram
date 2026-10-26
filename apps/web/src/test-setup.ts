/**
 * Runs before every `apps/web` test file. Testing Library's `findBy*`/`waitFor` give up after 1 s
 * by default, which a loaded Windows CI runner overran on a query that simply hadn't resolved yet
 * (`app-sidebar.test.tsx`, 1279 ms). A passing query returns as soon as it matches, so the longer
 * ceiling only costs time on a genuine failure.
 */
import { configure } from "@testing-library/dom";
import { beforeEach } from "vitest";

// Keep Node's intentional no-window branch. DOM tests own disposable Web Storage; capture it
// before a test can install denied/quota mocks, and clear those original stores between tests.
if (typeof window !== "undefined") {
  const local = window.localStorage;
  const session = window.sessionStorage;
  beforeEach(() => {
    local.clear();
    session.clear();
  });

  // Web Animations: cancel() rejects the current `finished` promise and marks it handled, so a
  // browser never reports it. happy-dom rejects it unhandled; Motion's WAAPI transforms cancel
  // animations constantly, and each one surfaced as an unhandled AbortError.
  const cancel = window.Animation?.prototype.cancel;
  if (cancel) {
    window.Animation.prototype.cancel = function (this: Animation) {
      this.finished.catch(() => {});
      cancel.call(this);
    };
  }
}

configure({ asyncUtilTimeout: 5000 });
