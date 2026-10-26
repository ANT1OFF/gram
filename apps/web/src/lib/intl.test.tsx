// @vitest-environment happy-dom
import type { UsageOverviewRow } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ModelTable } from "@/usage/usage-model-table";
import { dayLabel } from "@/usage/usage-model";

import { dateTimeFormat, numberFormat } from "./intl";
import { formatClockTime, notificationTime } from "./time";

/** Runs `body` and returns how many `Intl.DateTimeFormat`s and `Intl.NumberFormat`s it built. */
const countBuilds = (body: () => void) => {
  const real = { DateTimeFormat: Intl.DateTimeFormat, NumberFormat: Intl.NumberFormat };
  const built = { dateTime: 0, number: 0 };
  const counting = <T extends object>(target: T, key: keyof typeof built) =>
    new Proxy(target, {
      construct(constructor, args) {
        built[key]++;
        return Reflect.construct(constructor as new (...a: unknown[]) => object, args);
      },
      apply(constructor, self, args) {
        built[key]++;
        return Reflect.apply(constructor as (...a: unknown[]) => unknown, self, args);
      },
    });
  Intl.DateTimeFormat = counting(real.DateTimeFormat, "dateTime");
  Intl.NumberFormat = counting(real.NumberFormat, "number");
  try {
    body();
  } finally {
    Intl.DateTimeFormat = real.DateTimeFormat;
    Intl.NumberFormat = real.NumberFormat;
  }
  return built;
};

afterEach(cleanup);

describe("shared Intl formatters", () => {
  it("builds one formatter per distinct locale and options", () => {
    const a = dateTimeFormat("en-GB", { day: "numeric", month: "short" });
    expect(dateTimeFormat("en-GB", { day: "numeric", month: "short" })).toBe(a);
    expect(dateTimeFormat("en-US", { day: "numeric", month: "short" })).not.toBe(a);
    expect(dateTimeFormat("en-GB", { day: "numeric", month: "long" })).not.toBe(a);
    expect(numberFormat("en", { maximumFractionDigits: 0 })).toBe(
      numberFormat("en", { maximumFractionDigits: 0 }),
    );
    expect(numberFormat("en", { maximumFractionDigits: 0 }).format(1234.4)).toBe("1,234");
  });

  it("formats clock times and dates for a long list without building a formatter per row", () => {
    const intl = { locale: "en-US", timeZone: "Europe/Oslo" };
    const at = Date.UTC(2026, 9, 6, 12, 37);
    // Warm: the first call of each kind builds its formatter.
    formatClockTime(at, intl);
    notificationTime(at, intl);
    dayLabel("2026-10-06");
    const built = countBuilds(() => {
      for (let i = 0; i < 500; i++) {
        expect(formatClockTime(at + i * 60_000, intl)).toMatch(/^\d\d:\d\d$/);
        notificationTime(at + i * 60_000, intl);
        dayLabel("2026-10-06");
      }
    });
    expect(built).toEqual({ dateTime: 0, number: 0 });
  });

  it("renders the Usage model table of a quarter's rows without building number formats", () => {
    const models = ["model-a", "model-b", "model-c", "model-d", "model-e", "model-f"];
    const rows: UsageOverviewRow[] = Array.from({ length: 90 }, (_, d) =>
      models.map((model, m) => ({
        day: `2026-0${7 + Math.floor(d / 31)}-${String((d % 28) + 1).padStart(2, "0")}`,
        provider: m % 2 === 0 ? ("claude" as const) : ("codex" as const),
        model,
        turns: d + m,
        missingCacheRead: false,
        missingCacheWrite: false,
        totals: {
          totalTokens: 1_234_567 + d,
          uncachedInputTokens: 1_000,
          cacheReadTokens: 200_000,
          cacheWriteTokens: 30_000,
          unclassifiedInputTokens: 0,
          outputTokens: 4_567,
        },
      })),
    ).flat();
    const built = countBuilds(() => {
      render(<ModelTable rows={rows} history={false} />);
    });
    expect(screen.getAllByText("1,234,567").length).toBeGreaterThan(0);
    expect(built.number).toBe(0);
  });
});
