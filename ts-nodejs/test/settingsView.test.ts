// Settings form pins (SPEC 13): backfill on open, option rendering, the
// SPEC 11.1 selection style (white on accent), checkbox/pill/save states,
// and the wrap-around cycling that app.ts wires to Left/Right/Enter.

import { describe, expect, test } from "./bun-shim.ts";
import { defaultSettings } from "../src/core/settings.ts";
import { MOONLIT, MOONDARK } from "../src/core/theme.ts";
import { lineText } from "../src/tui/line.ts";
import {
  cycle,
  INTERVAL_OPTIONS,
  renderSettingsRows,
  SETTINGS_FIELD_COUNT,
  SETTINGS_FOOTER,
  THEME_OPTIONS,
} from "../src/tui/settingsView.ts";

const P = MOONLIT;
const draft = (over: Partial<ReturnType<typeof defaultSettings>> = {}) => ({
  ...defaultSettings(),
  ...over,
});

const grid = (d = draft(), sel = 0, width = 80) =>
  renderSettingsRows({ draft: d, sel, width, palette: P }).map(lineText);

describe("settings form layout (SPEC 13.1/13.2)", () => {
  test("title, headings and all four fields render in order", () => {
    const g = grid();
    expect(g[1]).toBe("  Kimi Planbar TUI Settings".padEnd(80));
    const text = g.join("\n");
    expect(text).toContain("Theme");
    expect(text).toContain("System default");
    expect(text).toContain("Moonlit (light)");
    expect(text).toContain("Moondark (dark)");
    expect(text).toContain("Refresh interval");
    expect(text).toContain(" 1 min ");
    expect(text).toContain(" 30 min ");
    expect(text).toContain("Launch at Windows startup");
    expect(text).toContain(" Save ");
  });

  test("opening backfills the current values (SPEC 13.2)", () => {
    const g = grid(draft({ theme: "dark", refreshMinutes: 10, autoStart: true }));
    const text = g.join("\n");
    expect(text).toContain("(●) Moondark (dark)");
    expect(text).toContain("( ) System default");
    expect(text).toContain("[x] Launch at Windows startup");
    const pillRow = g.find((l) => l.includes("10 min"))!;
    // Active pill text is present; the other marks stay inactive.
    expect(pillRow).toContain(" 10 min ");
    expect(text).not.toContain("(●) System default");
  });

  test("defaults: system theme, 5 min, no autostart", () => {
    const text = grid().join("\n");
    expect(text).toContain("(●) System default");
    expect(text).toContain("[ ] Launch at Windows startup");
  });

  test("the footer advertises the form keys", () => {
    expect(SETTINGS_FOOTER).toBe("↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel");
    expect(SETTINGS_FIELD_COUNT).toBe(4);
  });
});

describe("settings selection style (mirrors rust sel_style)", () => {
  test("the selected radio row is text_primary on button_hover, both themes", () => {
    for (const palette of [MOONLIT, MOONDARK]) {
      const rows = renderSettingsRows({ draft: draft(), sel: 0, width: 80, palette });
      const themeRow = rows.find((l) => lineText(l).includes("System default"))!;
      // Rust: mark span keeps its own accent/secondary fg, only the label
      // span carries the cursor highlight.
      expect(themeRow.spans[0]!.text).toBe("(●) ");
      expect(themeRow.spans[0]!.fg).toBe(palette.accent);
      expect(themeRow.spans[0]!.bg).toBeUndefined();
      expect(themeRow.spans[1]!.text).toBe("System default");
      expect(themeRow.spans[1]!.fg).toBe(palette.textPrimary);
      expect(themeRow.spans[1]!.bg).toBe(palette.buttonHover);
    }
  });

  test("a non-selected radio row keeps the palette colors and accent mark", () => {
    const rows = renderSettingsRows({ draft: draft(), sel: 1, width: 80, palette: P });
    const themeRow = rows.find((l) => lineText(l).includes("System default"))!;
    expect(themeRow.spans[0]!.fg).toBe(P.accent); // the active mark
    expect(themeRow.spans[1]!.fg).toBe(P.textPrimary);
    expect(themeRow.spans[1]!.bg).toBeUndefined();
  });

  test("the interval row cursor is an underline; the active pill stays white on accent", () => {
    const rows = renderSettingsRows({ draft: draft(), sel: 1, width: 80, palette: P });
    const pillRow = rows.find((l) => lineText(l).includes(" 5 min "))!;
    const active = pillRow.spans.find((s) => s.text === " 5 min ")!;
    expect(active.fg).toBe("#FFFFFF");
    expect(active.bg).toBe(P.accent);
    expect(active.underline).toBe(true);
    const inactive = pillRow.spans.find((s) => s.text === " 1 min ")!;
    expect(inactive.bg).toBe(P.buttonBg);
    expect(inactive.underline).toBe(true);
  });

  test("the selected Save action is white on accent; otherwise button_bg", () => {
    const selected = renderSettingsRows({ draft: draft(), sel: 3, width: 80, palette: P });
    const saveSel = selected.find((l) => lineText(l).includes(" Save "))!.spans[0]!;
    expect([saveSel.fg, saveSel.bg]).toEqual(["#FFFFFF", P.accent]);
    const idle = renderSettingsRows({ draft: draft(), sel: 0, width: 80, palette: P });
    const saveIdle = idle.find((l) => lineText(l).includes(" Save "))!.spans[0]!;
    expect([saveIdle.fg, saveIdle.bg]).toEqual([P.textPrimary, P.buttonBg]);
  });

  test("the selected checkbox row highlights only the label span", () => {
    const rows = renderSettingsRows({ draft: draft({ autoStart: true }), sel: 2, width: 80, palette: P });
    const row = rows.find((l) => lineText(l).includes("Launch at Windows startup"))!;
    expect(row.spans[0]!.text).toBe("[x] ");
    expect(row.spans[0]!.fg).toBe(P.accent);
    expect(row.spans[0]!.bg).toBeUndefined();
    expect(row.spans[1]!.text).toBe("Launch at Windows startup");
    expect(row.spans[1]!.bg).toBe(P.buttonHover);
  });
});

describe("cycle (rust app.rs `cycle`)", () => {
  const themes = THEME_OPTIONS.map((o) => o[0]);
  const intervals = INTERVAL_OPTIONS.map((o) => o[0]);

  test("wraps around both ends", () => {
    expect(cycle(themes, "dark", 1)).toBe("system");
    expect(cycle(themes, "system", -1)).toBe("dark");
    expect(cycle(intervals, 30, 1)).toBe(1);
    expect(cycle(intervals, 1, -1)).toBe(30);
  });

  test("steps through the middle and recovers from an unknown value", () => {
    expect(cycle(themes, "system", 1)).toBe("light");
    expect(cycle(intervals, 5, -1)).toBe(1);
    expect(cycle(themes, "bogus", 1)).toBe("light"); // unwrap_or(0), then step
  });
});
