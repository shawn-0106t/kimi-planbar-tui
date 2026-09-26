// Settings form view — a pure port of rust/src/ui/settings_view.rs to the
// TuiLine model (SPEC 13.1/13.2): theme radios x3, interval pills x4,
// autostart checkbox, Save action row. No @opentui imports: this returns data
// rows, selection and draft come in as arguments, so the whole form is
// snapshot-testable without a terminal.
//
// Row placement mirrors the Rust vertical layout — Length(3) title chunk with
// Padding(2, 0, 1, 0) puts the heading on screen row 1 at indent 2, and the
// content chunk starts right below it (row 3): its bottom row already acts as
// the spacer, so there is no extra inset row. Layout budget (REVIEW-RUST
// Major B): the form is 9 content lines — no blank rows between groups beyond
// the one under the Theme heading — so checkbox, Save and footer all stay
// visible at the 72×13 minimal window (3 + 9 + 1 = 13, SPEC 20).

import type { SettingsData } from "../core/settings.ts";
import type { Palette } from "../core/theme.ts";
import { padLineToWidth, tline, tspan, type TuiLine } from "./line.ts";

export const SETTINGS_FOOTER = "↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel · q Quit";

/** A failed Save swaps the footer for a hint until the next attempt, Esc, or
 *  form re-open (SPEC 13.2: a failed save must never read as saved, and must
 *  not be a silent dead key either; REVIEW-RUST Suggestion 16). */
export const SETTINGS_SAVE_FAILED_FOOTER =
  "Save failed — could not write settings.json · Esc Cancel · q Quit";

const TITLE = "Kimi Planbar TUI Settings";
/** Length(3) title chunk: the form body begins at row 3 (REVIEW-RUST Major B:
 *  the old one-row inset cost a row the minimal window does not have). */
const HEADER_ROWS = 3;

/** SPEC 13.2 option tables (value, label). */
export const THEME_OPTIONS: readonly [string, string][] = [
  ["system", "System default"],
  ["light", "Moonlit (light)"],
  ["dark", "Moondark (dark)"],
];
export const INTERVAL_OPTIONS: readonly [number, string][] = [
  [1, "1 min"],
  [5, "5 min"],
  [10, "10 min"],
  [30, "30 min"],
];

/** ratatui uses Color::White for the active pill/Save text; OpenTUI resolves
 *  "white" to #FFFFFF; the selection-style rule lives in SPEC 11.1 and §22.5. */
const ACTIVE_FG = "#FFFFFF";

/** Selected row paints a button_hover background, like the Rust sel_style. */
const selStyle = (selected: boolean, p: Palette) =>
  selected ? { fg: p.textPrimary, bg: p.buttonHover } : { fg: p.textPrimary };

const heading = (text: string, p: Palette): TuiLine =>
  tline([tspan(text, { fg: p.textSecondary, bold: true })]);

const radio = (selectedValue: boolean, rowSelected: boolean, label: string, p: Palette): TuiLine =>
  tline([
    tspan(selectedValue ? "(●) " : "( ) ", { fg: selectedValue ? p.accent : p.textSecondary }),
    tspan(label, selStyle(rowSelected, p)),
  ]);

/** Interval pills share one row (the SPEC 13.2 horizontal StackPanel); every
 *  pill is underlined while the row holds the selection, as the Rust port does. */
function pillLine(draft: SettingsData, sel: number, p: Palette): TuiLine {
  const spans: TuiLine["spans"] = [];
  for (const [value, label] of INTERVAL_OPTIONS) {
    const active = draft.refreshMinutes === value;
    spans.push(
      tspan(` ${label} `, {
        fg: active ? ACTIVE_FG : p.textPrimary,
        bg: active ? p.accent : p.buttonBg,
        ...(sel === 1 ? { underline: true } : {}),
      }),
    );
    spans.push(tspan(" "));
  }
  return tline(spans);
}

export function settingsHeaderRows(p: Palette): TuiLine[] {
  return [
    tline([]),
    tline([tspan(`  ${TITLE}`, { fg: p.textPrimary, bold: true })]),
    tline([]),
  ];
}

/** The form as ratatui's Paragraph would lay it out, header rows included and
 *  nothing clipped (the caller owns the viewport). 9 content lines: no spacer
 *  rows between groups beyond the one under the Theme heading, so the form
 *  fits the 9 inner rows of the 72×13 minimal window (REVIEW-RUST Major B). */
export function renderSettingsFormRows(draft: SettingsData, sel: number, p: Palette): TuiLine[] {
  return [
    ...settingsHeaderRows(p),
    heading("Theme", p),
    tline([]),
    ...THEME_OPTIONS.map(([value, label]) => radio(draft.theme === value, sel === 0, label, p)),
    heading("Refresh interval", p),
    pillLine(draft, sel, p),
    tline([
      tspan(draft.autoStart ? "[x] " : "[ ] ", { fg: draft.autoStart ? p.accent : p.textSecondary }),
      tspan("Launch at Windows startup", selStyle(sel === 2, p)),
    ]),
    tline([
      tspan(" Save ", {
        fg: sel === 3 ? ACTIVE_FG : p.textPrimary,
        bg: sel === 3 ? p.accent : p.buttonBg,
      }),
    ]),
  ];
}

/** The settings body for this terminal: the header always shows, the form is
 *  clipped to the content area (height - header rows - footer row), which is
 *  what ratatui does to a Paragraph taller than its chunk. A missing draft
 *  renders the empty Paragraph (title only), like app.rs's early return. */
export function renderSettingsRows(input: {
  draft: SettingsData | null;
  sel: number;
  width: number;
  height: number;
  palette: Palette;
}): TuiLine[] {
  const { draft, sel, width, height, palette: p } = input;
  const viewport = Math.max(0, height - HEADER_ROWS - 1);
  const form = draft === null ? [] : renderSettingsFormRows(draft, sel, p).slice(HEADER_ROWS);
  return [...settingsHeaderRows(p), ...form.slice(0, viewport)].map((l) =>
    padLineToWidth(l, width, p.windowBg),
  );
}

export function settingsFooterLine(p: Palette, width: number, saveFailed = false): TuiLine {
  const text = saveFailed ? SETTINGS_SAVE_FAILED_FOOTER : SETTINGS_FOOTER;
  return padLineToWidth(tline([tspan(text, { fg: p.textSecondary })]), width, p.windowBg);
}
