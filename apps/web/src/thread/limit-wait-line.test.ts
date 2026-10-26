import { describe, expect, it } from "vitest";

import { limitClearedLabel, limitWaitLabel } from "./limit-wait-line";

const intl = { locale: "en-US", timeZone: "Europe/Oslo" };
const RESUME = Date.parse("2026-10-15T10:50:20Z");

describe("limitWaitLabel", () => {
  it("names the resume on the 24-hour clock", () => {
    expect(limitWaitLabel({ kind: "limit", resumeAt: RESUME }, RESUME - 60_000, intl)).toBe(
      "Limit reached · resumes 12:50",
    );
    expect(limitWaitLabel({ kind: "backoff", resumeAt: RESUME }, RESUME - 60_000, intl)).toBe(
      "Rate limited · retries 12:50",
    );
  });

  it("names the day of a resume that isn't today's", () => {
    const evening = Date.parse("2026-10-15T20:00:00Z");
    expect(
      limitWaitLabel(
        { kind: "limit", resumeAt: Date.parse("2026-10-17T19:00:20Z") },
        evening,
        intl,
      ),
    ).toBe("Limit reached · resumes Sat 21:00");
  });

  it("says auto-resume is off once the user cancelled the wait", () => {
    expect(
      limitWaitLabel({ kind: "limit", resumeAt: RESUME, cancelled: true }, RESUME - 60_000, intl),
    ).toBe("Limit reached · auto-resume off");
  });

  it("says on hold once the resume time passes with the thread still waiting", () => {
    expect(limitWaitLabel({ kind: "limit", resumeAt: RESUME }, RESUME, intl)).toBe(
      "Limit reset · on hold",
    );
  });

  it("says the limit cleared when fresh data ended the wait early", () => {
    expect(
      limitWaitLabel(
        { kind: "limit", resumeAt: RESUME, cleared: RESUME - 30_000 },
        RESUME - 20_000,
        intl,
      ),
    ).toBe("Limit cleared · resumes 12:50");
    expect(limitClearedLabel({ at: RESUME, resetsAt: RESUME + 3_600_000 }, intl)).toBe(
      "Limit cleared · resumed 12:50",
    );
  });
});
