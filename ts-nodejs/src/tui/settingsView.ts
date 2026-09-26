// Settings form view (SPEC 13) — a pure function from draft state to rows,
// aligned element-for-element with rust/src/ui/settings_view.rs (options,
// copy, indentation and styles included). Save order (write JSON -> autostart
// -> theme -> reschedule) lives in app.ts; this module owns only the drawing
// and the option-cycling helpers.
//
// Selection style mirrors the Rust `sel_style`: the cursor row is
// text_primary on button_hover; white-on-accent marks the ACTIVE value
// (interval pill, selected Save action). Note SPEC 11.1's prose says the
// selection is white-on-accent — the Rust implementation is the behavior
// contract here, so this view follows Rust (see the M3-N report).

import type { SettingsData } from "../core/settings.ts";
import type { Palette } from "../core/theme.ts";
import { padLineToWidth, tline, tspan, type TuiLine, type TuiSpan } from "./line.ts";

export const SETTINGS_FOOTER = "↑/↓ Move · ←/→ Change · Enter Save/Toggle · Esc Cancel · q Quit";
/** A failed Save swaps the footer for a hint until the next attempt, Esc, or
 *  form re-open (SPEC 13.2: a failed save must never read as saved, and must
 *  not be a silent dead key either — REVIEW-RUST Suggestion 16 adds q Quit). */
export const SETTINGS_SAVE_FAILED_FOOTER =
  "Save failed — could not write settings.json · Esc Cancel · q Quit";

/** Field indexes: theme, interval, autostart, save. */
export const SETTINGS_FIELD_COUNT = 4;

export const THEME_OPTIONS: [string, string][] = [
  ["system", "System default"],
  ["light", "Moonlit (light)"],
  ["dark", "Moondark (dark)"],
];
export const INTERVAL_OPTIONS: [number, string][] = [
  [1, "1 min"],
  [5, "5 min"],
  [10, "10 min"],
  [30, "30 min"],
];

/** Wrap-around cycle through an option list (rust/src/app.rs `cycle`). An
 *  unknown current value restarts from the first option, like `unwrap_or(0)`. */
export function cycle<T>(options: readonly T[], current: T, dir: 1 | -1): T {
  const len = options.length;
  const idx = options.findIndex((o) => o === current);
  const from = idx < 0 ? 0 : idx;
  return options[(((from + dir) % len) + len) % len]!;
}

const WHITE = "#FFFFFF"; // ratatui Color::White, used by active pill / Save

/** rust `sel_style`: the cursor-row highlight. */
function selStyle(selected: boolean, p: Palette): Pick<TuiSpan, "fg" | "bg"> {
  return selected ? { fg: p.textPrimary, bg: p.buttonHover } : { fg: p.textPrimary };
}

function radioRow(activeValue: boolean, rowSelected: boolean, label: string, p: Palette): TuiLine {
  const mark = activeValue ? "(●)" : "( )";
  return tline([
    tspan(`${mark} `, { fg: activeValue ? p.accent : p.textSecondary }),
    tspan(label, selStyle(rowSelected, p)),
  ]);
}

export interface SettingsViewInput {
  /** The edit buffer: opened as a copy of the live settings (SPEC 13.2). */
  draft: SettingsData;
  sel: number;
  width: number;
  palette: Palette;
}

/** Full-screen settings rows, top-anchored; app.ts pads the vertical gap and
 *  pins the footer, exactly like the dashboard frame assembly.
 *
 *  Layout budget (REVIEW-RUST Major B): 3 title rows + 9 form lines so the
 *  whole form — checkbox, Save, footer — stays visible at the 72×13 minimal
 *  window (3 + 9 + 1 = 13). The old 13-line form (group spacers + a spacer
 *  row before the content, the TS counterpart of the Rust `Min(10)` and the
 *  content `+1` shift) clipped its last four rows. */
export function renderSettingsRows(input: SettingsViewInput): TuiLine[] {
  const { draft, sel, width, palette: p } = input;
  const rows: TuiLine[] = [];

  // Title area mirrors the Rust layout: 1 blank row, title (2-cell left
  // padding), 1 blank row — content starts right below, with no extra
  // spacer (the old +1 cost a row the minimal window does not have).
  rows.push(tline([]));
  rows.push(tline([tspan("  Kimi Planbar TUI Settings", { fg: p.textPrimary, bold: true })]));
  rows.push(tline([]));

  // 9 form lines: Theme heading + one spacer + 3 radios, then the interval
  // heading, pills, checkbox and Save with no spacers between groups — the
  // form must fit the 9 inner rows of the 72×13 minimal window (SPEC 13.1).
  const heading = (text: string): TuiLine => tline([tspan(text, { fg: p.textSecondary, bold: true })]);

  rows.push(heading("Theme"));
  rows.push(tline([]));
  for (const [value, label] of THEME_OPTIONS) {
    rows.push(radioRow(draft.theme === value, sel === 0, label, p));
  }

  rows.push(heading("Refresh interval"));
  const pills: TuiSpan[] = [];
  for (const [value, label] of INTERVAL_OPTIONS) {
    const active = draft.refreshMinutes === value;
    pills.push(
      tspan(` ${label} `, {
        fg: active ? WHITE : p.textPrimary,
        bg: active ? p.accent : p.buttonBg,
        underline: sel === 1 || undefined,
      }),
    );
    pills.push(tspan(" "));
  }
  rows.push(tline(pills));

  const checked = draft.autoStart;
  const check = checked ? "[x]" : "[ ]";
  rows.push(
    tline([
      tspan(`${check} `, { fg: checked ? p.accent : p.textSecondary }),
      tspan("Launch at Windows startup", selStyle(sel === 2, p)),
    ]),
  );

  rows.push(
    tline([
      tspan(" Save ", sel === 3 ? { fg: WHITE, bg: p.accent } : { fg: p.textPrimary, bg: p.buttonBg }),
    ]),
  );

  return rows.map((l) => padLineToWidth(l, width, p.windowBg));
}

export function settingsFooterLine(p: Palette, width: number, saveFailed = false): TuiLine {
  const text = saveFailed ? SETTINGS_SAVE_FAILED_FOOTER : SETTINGS_FOOTER;
  return padLineToWidth(tline([tspan(text, { fg: p.textSecondary })]), width, p.windowBg);
}
