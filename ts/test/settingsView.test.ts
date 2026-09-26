// Settings form snapshots: the TS counterpart of rust/src/ui/settings_view.rs,
// pinned row-by-row against SPEC 13.1/13.2 without a terminal.

import { describe, expect, test } from "bun:test";
import { MOONDARK, MOONLIT, type Palette } from "../src/core/theme.ts";
import type { SettingsData } from "../src/core/settings.ts";
import { createUiApp, renderFrame } from "../src/tui/app.ts";
import { lineText, lineWidth } from "../src/tui/line.ts";
import {
  renderSettingsFormRows,
  renderSettingsRows,
  SETTINGS_FOOTER,
  SETTINGS_SAVE_FAILED_FOOTER,
  settingsFooterLine,
} from "../src/tui/settingsView.ts";

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
    // REVIEW-RUST Major B: 9 content lines — no blank rows between groups
    // beyond the one under the Theme heading — and the content chunk starts
    // right below the title chunk (its bottom row acts as the spacer).
    expect(grid(settings(), 0)).toEqual([
      "",
      "  Kimi Planbar TUI Settings",
      "",
      "Theme",
      "",
      "(●) System default",
      "( ) Moonlit (light)",
      "( ) Moondark (dark)",
      "Refresh interval",
      " 1 min   5 min   10 min   30 min",
      "[ ] Launch at Windows startup",
      " Save",
    ]);
  });

  test("the radio and checkbox marks follow the draft, not the saved settings", () => {
    const g = grid(settings({ theme: "dark", autoStart: true }), 0);
    expect(g[5]).toBe("( ) System default");
    expect(g[7]).toBe("(●) Moondark (dark)");
    expect(g[10]).toBe("[x] Launch at Windows startup");
  });

  test("every row is padded to the terminal width so window_bg reaches the edge", () => {
    const rows = renderSettingsRows({ draft: settings(), sel: 0, width: 72, height: 24, palette: MOONDARK });
    for (const l of rows) expect(lineWidth(l)).toBe(72);
  });

  test("the whole form fits the 72×13 minimal window (REVIEW-RUST Major B + Suggestion 18)", () => {
    // The SPEC 20 minimal window: 3 title rows + 9 form rows + 1 footer row
    // = 13, rendered through the full frame like the Rust TestBackend test
    // (settings_form_fits_minimal_window). The old 13-line form clipped its
    // last four rows here. " Save " with surrounding spaces is the action
    // row; the footer's "Enter Save/Toggle" must not satisfy this assert.
    const app = createUiApp(null);
    app.view = "settings";
    app.settingsDraft = settings({ refreshMinutes: 1 });
    app.settingsSel = 3; // Save row selected
    const frame = renderFrame(app, MOONDARK, 72, 13);
    expect(frame.length).toBe(13);
    const screen = frame.map(lineText).join("\n");
    expect(screen).toContain("1 min");
    expect(screen).toContain("Launch at Windows startup");
    expect(screen).toContain(" Save ");
    expect(screen).toContain("q Quit");
  });

  test("a shorter terminal still clips the form like ratatui does", () => {
    // content area = 8 - 3 header rows - 1 footer row = 4 of the 9 form rows
    const g = grid(settings(), 0, 60, 8);
    expect(g.length).toBe(7);
    expect(g.slice(3)).toEqual(["Theme", "", "(●) System default", "( ) Moonlit (light)"]);
    expect(g.join("\n")).not.toContain("Save");
  });

  test("no draft renders the title with an empty body (app.rs early return)", () => {
    expect(grid(null, 0)).toEqual(["", "  Kimi Planbar TUI Settings", ""]);
  });

  test("the footer is the SPEC 13.1 key hint with the quit hint (REVIEW-RUST Suggestion 16)", () => {
    expect(SETTINGS_FOOTER).toBe("↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel · q Quit");
  });

  test("a failed save swaps in the Save failed footer (SPEC 13.2)", () => {
    expect(SETTINGS_SAVE_FAILED_FOOTER).toBe(
      "Save failed — could not write settings.json · Esc Cancel · q Quit",
    );
    const ok = settingsFooterLine(MOONLIT, 80, false);
    const failed = settingsFooterLine(MOONLIT, 80, true);
    expect(lineText(ok).trimEnd()).toBe(SETTINGS_FOOTER);
    expect(lineText(failed).trimEnd()).toBe(SETTINGS_SAVE_FAILED_FOOTER);
  });
});

describe("settings form styles (SPEC 11.1)", () => {
  const p = MOONLIT;

  test("the selected row paints button_hover behind its label", () => {
    const rows = renderSettingsFormRows(settings(), 0, p);
    // settings_view.rs passes `app.settings_sel == 0` as the row flag for
    // all three radios, so the whole Theme block is hovered while it is selected
    expect(rows[5]!.spans[1]!.bg).toBe(p.buttonHover);
    expect(rows[6]!.spans[1]!.bg).toBe(p.buttonHover);
    expect(rows[7]!.spans[1]!.bg).toBe(p.buttonHover);
    const offCursor = renderSettingsFormRows(settings(), 2, p);
    expect([offCursor[5]!.spans[1]!.fg, offCursor[5]!.spans[1]!.bg]).toEqual([p.textPrimary, undefined]);
    expect(offCursor[10]!.spans[1]!.bg).toBe(p.buttonHover); // the checkbox row
    expect(offCursor[11]!.spans[0]!.bg).toBe(p.buttonBg); // Save is not selected
  });

  test("the active radio mark is accent, an inactive one text_secondary", () => {
    const rows = renderSettingsFormRows(settings(), 0, p);
    expect(rows[5]!.spans[0]!.fg).toBe(p.accent);
    expect(rows[6]!.spans[0]!.fg).toBe(p.textSecondary);
    expect(rows[3]!.spans[0]!.bold).toBe(true); // "Theme" heading
    expect(rows[3]!.spans[0]!.fg).toBe(p.textSecondary);
  });

  test("pills: active is accent bg with white text, others button_bg", () => {
    const rows = renderSettingsFormRows(settings(), 0, p);
    const pills = rows[9]!.spans;
    expect(pills[0]!.text).toBe(" 1 min ");
    expect([pills[0]!.fg, pills[0]!.bg, pills[0]!.underline]).toEqual([p.textPrimary, p.buttonBg, undefined]);
    expect(pills[2]!.text).toBe(" 5 min ");
    expect([pills[2]!.fg, pills[2]!.bg]).toEqual(["#FFFFFF", p.accent]);
  });

  test("the interval row is underlined while it holds the selection", () => {
    const rows = renderSettingsFormRows(settings(), 1, p);
    for (const span of rows[9]!.spans) if (span.text.trim() !== "") expect(span.underline).toBe(true);
    // and the Save row takes the active pill style when selected
    const save = renderSettingsFormRows(settings(), 3, p)[11]!.spans[0]!;
    expect([save.fg, save.bg]).toEqual(["#FFFFFF", p.accent]);
  });
});
