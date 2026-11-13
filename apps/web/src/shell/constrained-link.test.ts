import { describe, expect, it } from "vitest";

import { linkIsConstrained } from "./constrained-link";

const download = (transferSize: number, ms: number) => ({
  transferSize,
  requestStart: 100,
  responseEnd: 100 + ms,
});

describe("linkIsConstrained", () => {
  it("measures the largest download: slow below 1 Mbit/s", () => {
    // 600 KB in 12 s is 400 kbit/s; in 1 s it is 4.8 Mbit/s.
    expect(linkIsConstrained([download(600_000, 12_000)])).toBe(true);
    expect(linkIsConstrained([download(600_000, 1_000)])).toBe(false);
    // The small file's latency says nothing; the large one decides.
    expect(linkIsConstrained([download(2_000, 900), download(600_000, 1_000)])).toBe(false);
  });

  it("takes the browser's word when nothing was measured", () => {
    // A cached file transfers no bytes.
    expect(linkIsConstrained([download(0, 2)])).toBe(false);
    expect(linkIsConstrained([download(0, 2)], { effectiveType: "3g" })).toBe(true);
    expect(linkIsConstrained([], { effectiveType: "4g" })).toBe(false);
    expect(linkIsConstrained([])).toBe(false);
  });

  it("a measurement outranks the browser's estimate, and Save-Data outranks both", () => {
    expect(linkIsConstrained([download(600_000, 1_000)], { effectiveType: "2g" })).toBe(false);
    expect(linkIsConstrained([download(600_000, 1_000)], { saveData: true })).toBe(true);
  });
});
