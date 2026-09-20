import { describe, expect, test } from "./bun-shim.ts";
import {
  clampPercent,
  f64ToI64Sat,
  fmtPercent,
  fmtYuan,
  formatReset,
  formatUpdated,
  rustRound,
} from "../src/core/format.ts";
import { dtFromParts, type RustDateTime } from "../src/core/json.ts";

const NOW = 1_893_456_000_000;
const at = (offsetMs: number): RustDateTime => dtFromParts(NOW + offsetMs, 0);

describe("fmtYuan (SPEC 12.5)", () => {
  test("fmt_yuan_examples, ported from rust/src/format.rs", () => {
    expect(fmtYuan(1234n)).toBe("¥12.34");
    expect(fmtYuan(10000n)).toBe("¥100");
    expect(fmtYuan(0n)).toBe("¥0");
    expect(fmtYuan(5n)).toBe("¥0.05");
    expect(fmtYuan(-1234n)).toBe("-¥12.34");
  });

  test("the sign sits outside the yuan sign and the fraction zero-pads", () => {
    expect(fmtYuan(100n)).toBe("¥1");
    expect(fmtYuan(1105n)).toBe("¥11.05");
    expect(fmtYuan(1100n)).toBe("¥11");
    expect(fmtYuan(-5n)).toBe("-¥0.05");
    expect(fmtYuan(100000000n)).toBe("¥1000000");
  });
});

describe("clampPercent (SPEC 12.2)", () => {
  test("clamp_percent_bounds, ported from rust/src/format.rs", () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(42)).toBe(42);
  });

  test("infinite input clamps rather than panicking", () => {
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("rustRound and f64 -> i64", () => {
  test("half away from zero, not Math.round's half up", () => {
    expect(rustRound(21.5)).toBe(22);
    expect(rustRound(-21.5)).toBe(-22);
    expect(rustRound(2.5)).toBe(3);
    expect(rustRound(-2.5)).toBe(-3);
    expect(rustRound(0.5)).toBe(1);
    expect(rustRound(-0.5)).toBe(-1);
    expect(rustRound(2.4)).toBe(2);
    expect(rustRound(-2.4)).toBe(-2);
  });

  test("the cast saturates", () => {
    expect(f64ToI64Sat(1e30)).toBe(9223372036854775807);
    expect(f64ToI64Sat(-1e30)).toBe(-9223372036854775808);
    expect(f64ToI64Sat(Number.NaN)).toBe(0);
    expect(f64ToI64Sat(7.9)).toBe(7);
  });
});

describe("fmtPercent (SPEC 12.2)", () => {
  test("integer percent, raw value, rounded away from zero", () => {
    expect(fmtPercent(21)).toBe("21%");
    expect(fmtPercent(21.5)).toBe("22%");
    expect(fmtPercent(-21.5)).toBe("-22%");
    expect(fmtPercent(0)).toBe("0%");
    expect(fmtPercent(5000)).toBe("5000%");
    expect(fmtPercent(Number.NaN)).toBe("0%");
  });
});

describe("formatReset (SPEC 12.3)", () => {
  const cases: [number, string][] = [
    [-1, "Resets soon"],
    [-86_400_000, "Resets soon"],
    [0, "Resets in 1m"],
    [59_999, "Resets in 1m"],
    [60_000, "Resets in 1m"],
    [119_999, "Resets in 1m"],
    [120_000, "Resets in 2m"],
    [3_599_999, "Resets in 59m"],
    [3_600_000, "Resets in 1h 0m"],
    [3_660_000, "Resets in 1h 1m"],
    [86_399_000, "Resets in 23h 59m"],
    [86_400_000, "Resets in 1d 0h"],
    [90_000_000, "Resets in 1d 1h"],
    [373_500_000, "Resets in 4d 7h"],
    [475_200_000, "Resets in 5d 12h"],
  ];

  for (const [offset, expected] of cases) {
    test(`${offset}ms -> ${expected}`, () => {
      expect(formatReset(at(offset), NOW)).toBe(expected);
    });
  }
});

describe("formatUpdated (SPEC 12.1)", () => {
  test("24-hour local HH:mm", () => {
    expect(formatUpdated(dtFromParts(Date.parse("2026-01-02T03:04:05Z"), 0))).toMatch(
      /^Updated \d{2}:\d{2}$/,
    );
  });
});
