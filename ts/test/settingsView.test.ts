// Settings form snapshots: the TS counterpart of rust/src/ui/settings_view.rs,
// pinned row-by-row against SPEC 13.1/13.2 without a terminal.

import { describe, expect, test } from "bun:test";
import { MOONDARK, MOONLIT, type Palette } from "../src/core/theme.ts";
import type { SettingsData } from "../src/core/settings.ts";
import { lineText, lineWidth } from "../src/tui/line.ts";
import { renderSettingsFormRows, renderSettingsRows, SETTINGS_FOOTER } from "../src/tui/settingsView.ts";

const settings = (over: Partial<SettingsData> = {}): SettingsData => ({
  theme: "system",
  refreshMinutes: 5,
  autoStart: false,
  ...over,
});

const grid = (draft: SettingsData | null, sel: number, width = 60, height = 24, p: Palette = MOONLIT) =>
  renderSettingsRows({ draft, sel, width, height, palette: p }).map((l) => lineText(l).replace(/\s+$/, ""));

describe("settings form rows (SPEC 13.1/13.2)", () => {
  test("the form reproduces the ratatui layout, header rows included", () => {
    expect(grid(settings(), 0)).toEqual([
      "",
      "  Kimi Planbar TUI Settings",
      "",
      "",
      "Theme",
      "",
      "(●) System default",
      "( ) Moonlit (light)",
      "( ) Moondark (dark)",
      "",
      "Refresh interval",
      "",
      " 1 min   5 min   10 min   30 min",
      "",
      "[ ] Launch at Windows startup",
      "",
      " Save",
    ]);
  });

  test("the radio and checkbox marks follow the draft, not the saved settings", () => {
    const g = grid(settings({ theme: "dark", autoStart: true }), 0);
    expect(g[6]).toBe("( ) System default");
    expect(g[8]).toBe("(●) Moondark (dark)");
    expect(g[14]).toBe("[x] Launch at Windows startup");
  });

  test("every row is padded to the terminal width so window_bg reaches the edge", () => {
    const rows = renderSettingsRows({ draft: settings(), sel: 0, width: 72, height: 24, palette: MOONDARK });
    for (const l of rows) expect(lineWidth(l)).toBe(72);
  });

  test("a 13-row terminal clips the form like the Min(10) chunk does", () => {
    // content area = 13 - 4 header rows - 1 footer row = 8 of the 13 form rows
    const g = grid(settings(), 0, 60, 13);
    expect(g.length).toBe(12);
    expect(g.slice(4)).toEqual(["Theme", "", "(●) System default", "( ) Moonlit (light)", "( ) Moondark (dark)", "", "Refresh interval", ""]);
    expect(g.join("\n")).not.toContain("Save");
  });

  test("no draft renders the title with an empty body (app.rs early return)", () => {
    expect(grid(null, 0)).toEqual(["", "  Kimi Planbar TUI Settings", "", ""]);
  });

  test("the footer is the SPEC 13.1 key hint", () => {
    expect(SETTINGS_FOOTER).toBe("↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel");
  });
});

describe("settings form styles (SPEC 11.1)", () => {
  const p = MOONLIT;

  test("the selected row paints button_hover behind its label", () => {
    const rows = renderSettingsFormRows(settings(), 0, p);
    // settings_view.rs:84 passes `app.settings_sel == 0` as the row flag for
    // all three radios, so the whole Theme block is hovered while it is selected
    expect(rows[6]!.spans[1]!.bg).toBe(p.buttonHover);
    expect(rows[7]!.spans[1]!.bg).toBe(p.buttonHover);
    expect(rows[8]!.spans[1]!.bg).toBe(p.buttonHover);
    const offCursor = renderSettingsFormRows(settings(), 2, p);
    expect([offCursor[6]!.spans[1]!.fg, offCursor[6]!.spans[1]!.bg]).toEqual([p.textPrimary, undefined]);
    expect(offCursor[14]!.spans[1]!.bg).toBe(p.buttonHover); // the checkbox row
    expect(offCursor[16]!.spans[0]!.bg).toBe(p.buttonBg); // Save is not selected
  });

  test("the active radio mark is accent, an inactive one text_secondary", () => {
    const rows = renderSettingsFormRows(settings(), 0, p);
    expect(rows[6]!.spans[0]!.fg).toBe(p.accent);
    expect(rows[7]!.spans[0]!.fg).toBe(p.textSecondary);
    expect(rows[4]!.spans[0]!.bold).toBe(true); // "Theme" heading
    expect(rows[4]!.spans[0]!.fg).toBe(p.textSecondary);
  });

  test("pills: active is accent bg with white text, others button_bg", () => {
    const rows = renderSettingsFormRows(settings(), 0, p);
    const pills = rows[12]!.spans;
    expect(pills[0]!.text).toBe(" 1 min ");
    expect([pills[0]!.fg, pills[0]!.bg, pills[0]!.underline]).toEqual([p.textPrimary, p.buttonBg, undefined]);
    expect(pills[2]!.text).toBe(" 5 min ");
    expect([pills[2]!.fg, pills[2]!.bg]).toEqual(["#FFFFFF", p.accent]);
  });

  test("the interval row is underlined while it holds the selection", () => {
    const rows = renderSettingsFormRows(settings(), 1, p);
    for (const span of rows[12]!.spans) if (span.text.trim() !== "") expect(span.underline).toBe(true);
    // and the Save row takes the active pill style when selected
    const save = renderSettingsFormRows(settings(), 3, p)[16]!.spans[0]!;
    expect([save.fg, save.bg]).toEqual(["#FFFFFF", p.accent]);
  });
});
