// Read-only skills view (SPEC 21.3), aligned with rust/src/ui/skills_view.rs:
// title "Kimi Skills" + "N skills" summary, rows grouped by source (group
// headers are not selectable), item = bold name line + indented description
// line, scrolled so the selected row stays in the viewport. Row construction
// and selection movement are pure and exported for tests; the scan lives in
// core/skills.ts, triggered from app.ts (first open uses the AppState cache,
// `r` forces a rescan — SPEC 21.2).
//
// Selection style mirrors the Rust draw(): the highlighted item is
// text_primary/bold (name) and text_secondary (description) on a
// button_hover background — not white-on-accent (SPEC 11.1's prose disagrees
// with the Rust behavior here; the Rust implementation is the contract).
//
// External data note: skill names/descriptions are emitted as plain span
// text; screen.ts sanitizes every span before it reaches the terminal, so
// escape sequences in a hostile SKILL.md cannot leave this layer alive.

import type { SkillInfo } from "../core/skills.ts";
import type { Palette } from "../core/theme.ts";
import { padLineToWidth, tline, tspan, type TuiLine } from "./line.ts";

export const SKILLS_FOOTER = "↑/↓ Scroll · r Rescan · Esc Back · q Quit";

/** Group headers separate the source sections; items are the skill entries. */
export type SkillsRow =
  | { kind: "group"; label: string }
  | { kind: "item"; name: string; description: string };

/** rust/src/app.rs `set_skills`: the input list is already sorted by source
 *  then case-insensitive name (core/skills.ts `sortSkills`), so grouping is a
 *  single pass that opens a new group whenever the source changes. */
export function buildSkillsRows(skills: SkillInfo[]): SkillsRow[] {
  const rows: SkillsRow[] = [];
  let lastSource: string | null = null;
  for (const s of skills) {
    if (lastSource !== s.source) {
      rows.push({ kind: "group", label: s.source });
      lastSource = s.source;
    }
    rows.push({ kind: "item", name: s.name, description: s.description });
  }
  return rows;
}

/** rust/src/app.rs `first_item`: index of the first selectable row, else 0. */
export function firstItemRow(rows: SkillsRow[]): number {
  const idx = rows.findIndex((r) => r.kind === "item");
  return idx < 0 ? 0 : idx;
}

/** rust/src/app.rs `move_skills_sel`: wrap-around move that skips group
 *  headers; an all-header list keeps the current index. */
export function moveSkillsSel(rows: SkillsRow[], sel: number, dir: 1 | -1): number {
  if (rows.length === 0) return 0;
  const len = rows.length;
  let i = sel;
  for (let n = 0; n < len; n++) {
    i = (((i + dir) % len) + len) % len;
    if (rows[i]!.kind === "item") return i;
  }
  return sel;
}

export interface SkillsViewInput {
  rows: SkillsRow[];
  sel: number;
  loading: boolean;
  width: number;
  /** Terminal height: the list viewport is height - 5 (title block of 4 rows
   *  plus the bottom-pinned footer), mirroring the Rust layout arithmetic. */
  height: number;
  palette: Palette;
}

export function renderSkillsRows(input: SkillsViewInput): TuiLine[] {
  const { rows, sel, loading, width, height, palette: p } = input;
  const nItems = rows.filter((r) => r.kind === "item").length;
  const summary = loading ? "Scanning..." : `${nItems} skills`;

  const out: TuiLine[] = [
    tline([]),
    tline([
      tspan("  Kimi Skills", { fg: p.textPrimary, bold: true }),
      tspan(`   ${summary}`, { fg: p.textSecondary }),
    ]),
    tline([]),
    tline([]),
  ];

  // One or two display lines per row: groups get a blank separator before
  // them (except the first), items are a name line + a description line.
  const lines: TuiLine[] = [];
  const rowLine: number[] = [];
  rows.forEach((row, idx) => {
    rowLine.push(lines.length);
    if (row.kind === "group") {
      if (idx > 0) lines.push(tline([]));
      lines.push(tline([tspan(row.label, { fg: p.accent, bold: true })]));
    } else {
      const selected = idx === sel;
      const nameStyle = selected
        ? { fg: p.textPrimary, bg: p.buttonHover, bold: true }
        : { fg: p.textPrimary, bold: true };
      const descStyle = selected
        ? { fg: p.textSecondary, bg: p.buttonHover }
        : { fg: p.textSecondary };
      lines.push(tline([tspan(`  ${row.name}`, nameStyle)]));
      // The description is NOT pre-clipped: screen.ts hard-clips at the
      // terminal width by cell count (SPEC 21.3 truncation).
      lines.push(tline([tspan(`    ${row.description}`, descStyle)]));
    }
  });

  // Keep the selected row's first line inside the viewport (rust: scroll calc).
  const viewport = Math.max(0, height - 5);
  const selLine = rowLine[sel] ?? 0;
  const maxScroll = Math.max(0, lines.length - viewport);
  const scroll = selLine >= viewport ? Math.min(selLine + 1 - viewport, maxScroll) : 0;
  out.push(...lines.slice(scroll, scroll + viewport));

  return out.map((l) => padLineToWidth(l, width, p.windowBg));
}

export function skillsFooterLine(p: Palette, width: number): TuiLine {
  return padLineToWidth(tline([tspan(SKILLS_FOOTER, { fg: p.textSecondary })]), width, p.windowBg);
}
