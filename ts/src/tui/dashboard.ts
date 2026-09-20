// Main dashboard view — a pure port of rust/src/ui/dashboard.rs to the TuiLine
// model (SPEC 12). No @opentui imports: this returns data rows as values, and
// the row order here mirrors the Rust vertical layout constraints one-for-one
// (title, blank, 5-hour, weekly, blank, extra, [monthly], blank, version);
// the Min(0) spacer and the bottom-pinned footer are the renderer's job.

import { clampPercent, fmtPercent, fmtYuan, formatReset, formatUpdated } from "../core/format.ts";
import type { QuotaResult, QuotaSegment } from "../core/quota.ts";
import type { Palette } from "../core/theme.ts";
import type { UpdateStatus } from "../core/update.ts";
import { padLineToWidth, tline, tspan, type TuiLine } from "./line.ts";

export const FOOTER = "r Refresh · s Settings · k Skills · c Console · g Releases · q Quit";
/// Column width for the row labels ("5-hour usage" / "Kimi Code CLI" fit).
const LABEL_W = 14;
/// Minimum bar width; below this the bar is dropped (very narrow terminals).
const MIN_BAR_W = 5;
/// ratatui title split: Min(10) + Length(16) — Length wins under scarcity.
const TITLE_RIGHT_W = 16;

export interface DashboardInput {
  quota: QuotaResult | null;
  update: UpdateStatus | null;
  /** Countdown text is recomputed on every redraw (SPEC 12.3). */
  nowMs: number;
  width: number;
  palette: Palette;
}

/** SPEC 12.1: right side of the title row. */
export function lastUpdatedText(quota: QuotaResult | null): string {
  if (quota === null) return "";
  if (quota.error !== null) return "Update failed";
  return formatUpdated(quota.fetchedAt);
}

function titleLine(p: Palette, width: number, quota: QuotaResult | null): TuiLine {
  const right = lastUpdatedText(quota);
  // ratatui Layout[Min(10), Length(16)]: Length wins under scarcity, so the
  // right column keeps its 16 cells down to the narrowest widths.
  const rightW = Math.min(TITLE_RIGHT_W, width);
  const leftW = Math.max(0, width - rightW);
  // ratatui clips each side into its column (the title included on tiny widths).
  const title = "Kimi Planbar TUI".slice(0, leftW);
  const visible = right.slice(0, rightW);
  const gap = Math.max(0, leftW + rightW - visible.length - title.length);
  const spans = [tspan(title, { fg: p.textPrimary, bold: true })];
  if (gap > 0) spans.push(tspan(" ".repeat(gap)));
  if (visible !== "") spans.push(tspan(visible, { fg: p.textSecondary }));
  return tline(spans);
}

/** Text bar spans: accent fill + dim track (SPEC 11.2: fill is always the
 *  accent color, no threshold-based color change). */
function barSpans(p: Palette, ratio: number, width: number) {
  const filled = Math.round(Math.min(Math.max(ratio, 0), 1) * width);
  return [
    tspan("█".repeat(filled), { fg: p.accent }),
    tspan("░".repeat(width - filled), { fg: p.progressTrack }),
  ];
}

/** One usage row (SPEC 12.2): "label  pct  bar  Resets in ...".
 *  `seg == null` renders the "--" default with an empty bar. */
export function usageLine(p: Palette, width: number, label: string, seg: QuotaSegment | null, nowMs: number): TuiLine {
  const pctText = seg ? fmtPercent(seg.percent) : "--";
  // The column budget is 4 cells; truncate rather than overflow the line
  // (a broken payload could otherwise push the reset text off-screen).
  const pct = pctText.slice(0, 4).padStart(4);
  const reset = seg?.resetAt ? formatReset(seg.resetAt, nowMs) : "";

  const spans = [
    tspan(label.padEnd(LABEL_W), { fg: p.textSecondary }),
    tspan(pct, { fg: p.textPrimary, bold: true }),
    tspan("  "),
  ];

  // Bar takes the space left after label + percent + reset text.
  const used = LABEL_W + 4 + 2 + (reset === "" ? 0 : reset.length + 2);
  const barW = Math.max(0, width - used);
  if (barW >= MIN_BAR_W) {
    // Display uses the raw percent; the bar uses the clamped value (SPEC 12.2).
    const ratio = seg ? clampPercent(seg.percent) / 100 : 0;
    spans.push(...barSpans(p, ratio, barW));
    spans.push(tspan("  "));
  }
  if (reset !== "") spans.push(tspan(reset, { fg: p.textSecondary }));
  return tline(spans);
}

/** SPEC 12.4: Extra Usage line — balance value by three-state, then the
 *  optional monthly line ("Used ¥x this month / ¥y limit"). */
function extraLines(p: Palette, quota: QuotaResult | null): TuiLine[] {
  const extra = quota?.extra ?? null;
  const balance =
    extra === null
      ? "--"
      : extra.state === "Ready"
        ? extra.balanceCents !== null
          ? fmtYuan(extra.balanceCents)
          : "--"
        : extra.state === "NoData"
          ? "No data"
          : "Not activated";
  const lines = [
    tline([
      tspan("Extra Usage".padEnd(LABEL_W), { fg: p.textSecondary }),
      tspan(balance, { fg: p.textPrimary, bold: true }),
    ]),
  ];

  // Monthly sub-line (SPEC 12.4): only when monthly enabled with a real
  // limit and a known used value.
  if (
    extra !== null &&
    extra.monthlyEnabled &&
    (extra.monthlyLimitCents ?? 0n) > 0n &&
    extra.monthlyUsedCents !== null
  ) {
    lines.push(
      tline([
        tspan(
          `  Used ${fmtYuan(extra.monthlyUsedCents)} this month / ${fmtYuan(extra.monthlyLimitCents ?? 1n)} limit`,
          { fg: p.textSecondary },
        ),
      ]),
    );
  }
  return lines;
}

/** SPEC 12.6: version line with the "Update available" badge (SPEC 17.4). */
function versionLine(p: Palette, update: UpdateStatus | null): TuiLine {
  const version = update === null ? "--" : update.localVersion ?? "Not detected";
  const spans = [
    tspan("Kimi Code CLI".padEnd(LABEL_W), { fg: p.textSecondary }),
    tspan(version, { fg: p.textPrimary }),
  ];
  if (update?.updateAvailable) {
    spans.push(tspan("  "));
    spans.push(tspan(" Update available ", { fg: p.badgeFg, bg: p.badgeBg }));
  }
  return tline(spans);
}

/** The dashboard frame as data rows (footer excluded — it is bottom-pinned
 *  by the renderer, mirroring the Min(0) spacer + Length(1) pair in Rust). */
export function renderDashboardRows(input: DashboardInput): { rows: TuiLine[]; monthlyShown: boolean } {
  const { quota, update, nowMs, width, palette: p } = input;
  const lines = extraLines(p, quota);
  const extra = lines[0]!;
  const monthly = lines[1];
  const monthlyShown = monthly !== undefined;

  const fiveHour = quota?.fiveHour ?? null;
  const week = quota?.week ?? null;

  const rows = [
    titleLine(p, width, quota),
    tline([]),
    usageLine(p, width, "5-hour usage", fiveHour, nowMs),
    usageLine(p, width, "Weekly usage", week, nowMs),
    tline([]),
    extra,
    ...(monthlyShown ? [monthly] : []),
    tline([]),
    versionLine(p, update),
  ];
  return {
    rows: rows.map((l) => padLineToWidth(l, width, p.windowBg)),
    monthlyShown,
  };
}

export function footerLine(p: Palette, width: number): TuiLine {
  return padLineToWidth(tline([tspan(FOOTER, { fg: p.textSecondary })]), width, p.windowBg);
}
