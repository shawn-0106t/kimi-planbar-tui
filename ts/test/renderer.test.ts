// Adapter-level integration on the OpenTUI test renderer (no real terminal):
// pins the three mechanics renderer.ts relies on and that the S0 probe could
// not cover end-to-end — in-place row replacement through the adapter, styled
// chunks (fg + bg + bold) reaching the cell buffer, and keypress delivery via
// renderer.keyInput (not renderer itself, see TS-EDITION-PLAN §2.6).

import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { dtFromParts } from "../src/core/json.ts";
import { MOONLIT } from "../src/core/theme.ts";
import type { QuotaResult } from "../src/core/quota.ts";
import { footerLine, renderDashboardRows } from "../src/tui/dashboard.ts";
import { blankLine, type TuiLine } from "../src/tui/line.ts";
import { wrapCliRenderer, type TuiRenderer } from "../src/tui/renderer.ts";

const NOW = Date.UTC(2026, 8, 19, 6, 35, 0);
const dt = (ms: number) => dtFromParts(ms, 0);

const quotaWith = (percent: number): QuotaResult => ({
  fiveHour: { percent, resetAt: dt(NOW + 4 * 3_600_000) },
  week: null,
  extra: null,
  fetchedAt: dt(NOW - 60_000),
  error: null,
});

function frameFor(quota: QuotaResult | null, width: number, height: number): TuiLine[] {
  const { rows } = renderDashboardRows({ quota, update: null, nowMs: NOW, width, palette: MOONLIT });
  const body = rows.length + 1 <= height ? rows : rows.slice(0, height - 1);
  const fillers = Array.from({ length: height - body.length - 1 }, () => blankLine(width, MOONLIT.windowBg));
  return [...body, ...fillers, footerLine(MOONLIT, width)];
}

const rowText = (setup: Awaited<ReturnType<typeof createTestRenderer>>, y: number): string =>
  setup.captureCharFrame()
    .split("\n")
    [y]!.trimEnd();

const hex = (color: string): RGBA => RGBA.fromHex(color);

describe("opentui adapter (renderer.ts)", () => {
  test("styled dashboard rows reach the cell buffer with palette colors", async () => {
    const setup = await createTestRenderer({ width: 72, height: 12 });
    const adapter: TuiRenderer = wrapCliRenderer(setup.renderer);
    adapter.renderRows(frameFor(quotaWith(21), 72, 12), MOONLIT.windowBg);
    await setup.renderOnce();

    const frame = setup.captureSpans();
    const title = frame.lines[0]!.spans.find((s) => s.text.includes("Kimi"))!;
    expect(title.fg.equals(hex(MOONLIT.textPrimary))).toBe(true);
    expect(title.attributes & 1).toBe(1); // bold bit (probe §2.6)
    // live WT check: runs without an explicit bg must sit on window_bg, never
    // the terminal default (that painted black stripes behind every label)
    expect(title.bg.equals(hex(MOONLIT.windowBg))).toBe(true);

    const usage = frame.lines[2]!.spans;
    const fill = usage.find((s) => s.text.startsWith("█"));
    const track = usage.find((s) => s.text.startsWith("░"));
    expect(fill?.fg.equals(hex(MOONLIT.accent))).toBe(true);
    expect(track?.fg.equals(hex(MOONLIT.progressTrack))).toBe(true);

    // probe trap 3: the padding run must carry window_bg to the right edge
    const extra = frame.lines[5]!.spans;
    const last = extra[extra.length - 1]!;
    expect(last.bg.equals(hex(MOONLIT.windowBg))).toBe(true);
    expect(rowText(setup, 2)).toContain("Resets in 4h 0m");

    adapter.destroy();
  });

  test("changed rows are rebuilt in place while unchanged rows keep their handles", async () => {
    const setup = await createTestRenderer({ width: 72, height: 12 });
    const adapter = wrapCliRenderer(setup.renderer);
    adapter.renderRows(frameFor(null, 72, 12), MOONLIT.windowBg);
    await setup.renderOnce();
    expect(rowText(setup, 2)).toContain("--");

    adapter.renderRows(frameFor(quotaWith(21), 72, 12), MOONLIT.windowBg);
    await setup.renderOnce();
    const line = rowText(setup, 2);
    expect(line).toContain("21%");
    expect(line).toContain("Resets in 4h 0m");
    // untouched rows (footer) survived the replacement at the right position
    expect(rowText(setup, 11)).toContain("r Refresh");
    expect(rowText(setup, 0)).toContain("Kimi Planbar TUI");

    adapter.destroy();
  });

  test("keypress routing listens on renderer.keyInput", async () => {
    const setup = await createTestRenderer({ width: 40, height: 6 });
    const adapter = wrapCliRenderer(setup.renderer);
    const got: string[] = [];
    adapter.onKey((k) => got.push(`${k.name}${k.shift ? "+" : ""}${k.ctrl ? "^" : ""}`));
    setup.mockInput.pressKey("q");
    setup.mockInput.pressKey("r", { shift: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(["q", "r+"]);
    adapter.destroy();
  });
});
