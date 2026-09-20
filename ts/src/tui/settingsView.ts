// Settings form view — a pure port of rust/src/ui/settings_view.rs to the
// TuiLine model (SPEC 13.1/13.2): theme radios x3, interval pills x4,
// autostart checkbox, Save action row. No @opentui imports: this returns data
// rows, selection and draft come in as arguments, so the whole form is
// snapshot-testable without a terminal.
//
// Row placement mirrors the Rust vertical layout — Length(3) title chunk with
// Padding(2, 0, 1, 0) puts the heading on screen row 1 at indent 2, the Min(10)
// chunk starts at row 3 and its Paragraph is inset one more row, so the form
// body begins at row 4; Length(1) keeps the footer on the last row.

import type { SettingsData } from "../core/settings.ts";
import type { Palette } from "../core/theme.ts";
import { padLineToWidth, tline, tspan, type TuiLine } from "./line.ts";

export const SETTINGS_FOOTER = "↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel";

const TITLE = "Kimi Planbar TUI Settings";
/** Length(3) chunk + the one-row inset of the Min(10) chunk = 4 header rows. */
const HEADER_ROWS = 4;

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
    tline([]),
  ];
}

/** The form as ratatui's Paragraph would lay it out, header rows included and
 *  nothing clipped (the caller owns the viewport). */
export function renderSettingsFormRows(draft: SettingsData, sel: number, p: Palette): TuiLine[] {
  return [
    ...settingsHeaderRows(p),
    heading("Theme", p),
    tline([]),
    ...THEME_OPTIONS.map(([value, label]) => radio(draft.theme === value, sel === 0, label, p)),
    tline([]),
    heading("Refresh interval", p),
    tline([]),
    pillLine(draft, sel, p),
    tline([]),
    tline([
      tspan(draft.autoStart ? "[x] " : "[ ] ", { fg: draft.autoStart ? p.accent : p.textSecondary }),
      tspan("Launch at Windows startup", selStyle(sel === 2, p)),
    ]),
    tline([]),
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

export function settingsFooterLine(p: Palette, width: number): TuiLine {
  return padLineToWidth(tline([tspan(SETTINGS_FOOTER, { fg: p.textSecondary })]), width, p.windowBg);
}
