// Dashboard line snapshots: the TuiLine[] grid is the TS counterpart of what
// ratatui renders for rust/src/ui/dashboard.rs, so these tests pin SPEC 12
// row-by-row (text + span styles) without touching a real terminal.

import { describe, expect, test } from "./bun-shim.ts";
import { dtFromParts, type RustDateTime } from "../src/core/json.ts";
import type { QuotaResult, QuotaSegment, ExtraInfo } from "../src/core/quota.ts";
import type { UpdateStatus } from "../src/core/update.ts";
import { MOONDARK, MOONLIT, type Palette } from "../src/core/theme.ts";
import { footerLine, renderDashboardRows, usageLine } from "../src/tui/dashboard.ts";
import { lineText, lineWidth, type TuiLine } from "../src/tui/line.ts";

// 2026-09-19 14:35 +08:00 — the suite runs with TZ=Asia/Shanghai (package.json),
// so "Updated" shows 14:34 for a stamp one minute older.
const NOW = Date.UTC(2026, 8, 19, 6, 35, 0);
const H = 3_600_000;
const D = 86_400_000;
const dt = (ms: number): RustDateTime => dtFromParts(ms, 0);

const seg = (percent: number, resetAt: RustDateTime | null): QuotaSegment => ({ percent, resetAt });
const extra = (over: Partial<ExtraInfo> = {}): ExtraInfo => ({
  state: "Ready",
  balanceCents: 1234n,
  monthlyEnabled: false,
  monthlyUsedCents: null,
  monthlyLimitCents: null,
  ...over,
});
const quota = (over: Partial<QuotaResult> = {}): QuotaResult => ({
  fiveHour: null,
  week: null,
  extra: null,
  fetchedAt: dt(NOW - 60_000),
  error: null,
  ...over,
});
const update = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  localVersion: "2.0.1",
  latestVersion: null,
  updateAvailable: false,
  checkFailed: false,
  ...over,
});

const P = MOONLIT;

function grid(input: {
  quota: QuotaResult | null;
  update: UpdateStatus | null;
  width: number;
  palette?: Palette;
}): string[] {
  const { rows } = renderDashboardRows({ nowMs: NOW, ...input, palette: input.palette ?? P });
  return [...rows, footerLine(input.palette ?? P, input.width)].map(lineText);
}

describe("dashboard wireframe (SPEC 12)", () => {
  test("a full success frame at width 80 reproduces the SPEC 12 layout", () => {
    const g = grid({
      quota: quota({
        fiveHour: seg(21, dt(NOW + 4 * H + 30 * 60_000)),
        week: seg(18, dt(NOW + 5 * D + 15 * H)),
        extra: extra({ monthlyEnabled: true, monthlyUsedCents: 4567n, monthlyLimitCents: 10000n }),
      }),
      update: update(),
      width: 80,
    });
    expect(g).toEqual([
      "Kimi Planbar TUI".padEnd(80 - 13) + "Updated 14:34",
      " ".repeat(80),
      "5-hour usage   21%  " + "█".repeat(9) + "░".repeat(33) + "  Resets in 4h 30m",
      "Weekly usage   18%  " + "█".repeat(8) + "░".repeat(34) + "  Resets in 5d 15h",
      " ".repeat(80),
      "Extra Usage   ¥12.34".padEnd(80),
      "  Used ¥45.67 this month / ¥100 limit".padEnd(80),
      " ".repeat(80),
      "Kimi Code CLI 2.0.1".padEnd(80),
      "r Refresh · s Settings · k Skills · c Console · g Releases · q Quit".padEnd(80),
    ]);
  });

  test("every row is exactly the terminal width (bg reaches the right edge)", () => {
    const { rows } = renderDashboardRows({
      quota: quota({ fiveHour: seg(21, dt(NOW + 4 * H)) }),
      update: update(),
      nowMs: NOW,
      width: 72,
      palette: MOONDARK,
    });
    for (const l of [...rows, footerLine(MOONDARK, 72)]) expect(lineWidth(l)).toBe(72);
  });

  test("cold start: -- placeholders, an all-track bar and no right title", () => {
    const g = grid({ quota: null, update: null, width: 80 });
    expect(g[0]!.startsWith("Kimi Planbar TUI")).toBe(true);
    expect(g[0]!.trimEnd().endsWith("TUI")).toBe(true);
    // bar budget: 80 - (14+4+2) = 60 cells; the two gap spaces after the bar
    // push the line to 82 and get clipped away
    expect(g[2]).toBe("5-hour usage    --  " + "░".repeat(60));
    expect(g[3]).toBe("Weekly usage    --  " + "░".repeat(60));
    expect(g[5]).toBe("Extra Usage   --".padEnd(80));
    expect(g[7]).toBe("Kimi Code CLI --".padEnd(80));
  });

  test("failure keeps the last-good segments and swaps the title stamp (SPEC 12.1/16.5)", () => {
    const g = grid({
      quota: quota({
        error: "HttpRequestException",
        fiveHour: seg(21, dt(NOW + 4 * H + 30 * 60_000)),
        fetchedAt: dt(NOW),
      }),
      update: update(),
      width: 80,
    });
    expect(g[0]!.trimEnd().endsWith("Update failed")).toBe(true);
    expect(g[2]!.trimEnd().endsWith("Resets in 4h 30m")).toBe(true);
  });

  test("the bar is dropped when fewer than 5 cells remain (SPEC 12.2)", () => {
    // width 42: label+pct+gap = 20, reset budget 18, bar would get 4 cells
    const g = grid({
      quota: quota({ fiveHour: seg(21, dt(NOW + 4 * H + 30 * 60_000)) }),
      update: null,
      width: 42,
    });
    expect(g[2]!.trimEnd()).toBe("5-hour usage   21%  Resets in 4h 30m");
    expect(g[2]!.length).toBe(42);
    expect(g[2]).not.toContain("█");
    expect(g[2]).not.toContain("░");
  });

  test("tiny width 30 clips the usage row at the right edge", () => {
    const g = grid({
      quota: quota({ fiveHour: seg(21, dt(NOW + 4 * H + 30 * 60_000)) }),
      update: null,
      width: 30,
    });
    expect(g[2]).toBe(("5-hour usage   21%  Resets in 4h 30m").slice(0, 30));
  });

  test("percent display is unclamped while the bar is clamped (SPEC 12.2)", () => {
    const p = MOONLIT;
    const hot = usageLine(p, 80, "5-hour usage", seg(120.4, null), NOW);
    expect(lineText(hot).slice(0, 20)).toBe("5-hour usage  120%  ");
    expect(lineText(hot)).toContain("█".repeat(60));
    const cold = usageLine(p, 80, "Weekly usage", seg(-5, null), NOW);
    expect(lineText(cold).slice(0, 20)).toBe("Weekly usage   -5%  ");
    expect(lineText(cold)).toContain("░".repeat(60));
  });

  test("a percent longer than the 4-cell column is truncated, not overflowed", () => {
    const line = usageLine(MOONLIT, 80, "5-hour usage", seg(999995, null), NOW);
    // "999995%" -> chars().take(4) -> "9999" (the % is eaten, like the Rust port)
    expect(lineText(line).slice(0, 20)).toBe("5-hour usage  9999  ");
  });

  test("Extra Usage three states (SPEC 12.4)", () => {
    expect(grid({ quota: quota({ extra: extra({ state: "NotActivated", balanceCents: null }) }), update: null, width: 80 })[5]!.trimEnd()).toBe("Extra Usage   Not activated");
    expect(grid({ quota: quota({ extra: extra({ state: "NoData", balanceCents: null }) }), update: null, width: 80 })[5]!.trimEnd()).toBe("Extra Usage   No data");
    expect(grid({ quota: quota({ extra: extra({ balanceCents: null }) }), update: null, width: 80 })[5]!.trimEnd()).toBe("Extra Usage   --");
  });

  test("the monthly sub-line needs enabled + real limit + known used (SPEC 12.4)", () => {
    const { rows: noLimit } = renderDashboardRows({
      quota: quota({ extra: extra({ monthlyEnabled: true, monthlyUsedCents: 100n, monthlyLimitCents: 0n }) }),
      update: null,
      nowMs: NOW,
      width: 80,
      palette: P,
    });
    expect(noLimit.length).toBe(8);
    const { rows: withMonthly, monthlyShown } = renderDashboardRows({
      quota: quota({ extra: extra({ monthlyEnabled: true, monthlyUsedCents: 100n, monthlyLimitCents: 20000n }) }),
      update: null,
      nowMs: NOW,
      width: 80,
      palette: P,
    });
    expect(monthlyShown).toBe(true);
    expect(withMonthly.length).toBe(9);
    expect(lineText(withMonthly[6]!)).toBe("  Used ¥1 this month / ¥200 limit".padEnd(80));
  });

  test("the update badge appears with its own colors (SPEC 12.6/17.4)", () => {
    const { rows } = renderDashboardRows({
      quota: null,
      update: update({ updateAvailable: true }),
      nowMs: NOW,
      width: 80,
      palette: P,
    });
    const version = rows[7]!;
    expect(lineText(version).slice(0, 39)).toBe("Kimi Code CLI 2.0.1   Update available ");
    const badge = version.spans.find((s) => s.text === " Update available ");
    expect(badge).toEqual({ text: " Update available ", fg: P.badgeFg, bg: P.badgeBg });
  });
});

describe("dashboard span styles (SPEC 11)", () => {
  const richRow = (): TuiLine => {
    const { rows } = renderDashboardRows({
      quota: quota({ fiveHour: seg(21, dt(NOW + 4 * H + 30 * 60_000)) }),
      update: null,
      nowMs: NOW,
      width: 80,
      palette: P,
    });
    return rows[2]!;
  };

  test("label, percent, bar and countdown carry their palette slots (SPEC 11.1/11.2)", () => {
    const [label, pct, gap, fill, track, gap2, reset] = richRow().spans;
    expect([label, pct, gap, fill, track, gap2, reset].map((s) => s?.fg)).toEqual([
      P.textSecondary,
      P.textPrimary,
      undefined,
      P.accent,
      P.progressTrack,
      undefined,
      P.textSecondary,
    ]);
    expect(pct?.bold).toBe(true);
    expect(label?.bold).toBeUndefined();
  });

  test("the trailing filler run paints window_bg to the right edge", () => {
    const { rows } = renderDashboardRows({ quota: null, update: null, nowMs: NOW, width: 80, palette: P });
    const extra = rows[5]!;
    const last = extra.spans[extra.spans.length - 1]!;
    expect(last.fg).toBeUndefined();
    expect(last.bg).toBe(P.windowBg);
    expect(lineWidth(extra)).toBe(80);
  });

  test("the title is bold text_primary and the stamp is text_secondary", () => {
    const { rows } = renderDashboardRows({
      quota: quota({}),
      update: null,
      nowMs: NOW,
      width: 80,
      palette: P,
    });
    const [title, gap, stamp] = rows[0]!.spans;
    expect([title?.text, title?.bold, title?.fg]).toEqual(["Kimi Planbar TUI", true, P.textPrimary]);
    expect(stamp?.fg).toBe(P.textSecondary);
    expect(stamp?.text).toBe("Updated 14:34");
    expect(gap?.text.length).toBe(80 - 16 - 13);
  });
});
