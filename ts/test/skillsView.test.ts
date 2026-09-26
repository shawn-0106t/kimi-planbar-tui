// Skills list snapshots: the TS counterpart of rust/src/ui/skills_view.rs
// plus app.rs::set_skills / move_skills_sel, pinned against SPEC 21.3.

import { describe, expect, test } from "bun:test";
import type { SkillInfo } from "../src/core/skills.ts";
import { MOONLIT, type Palette } from "../src/core/theme.ts";
import { lineText, lineWidth } from "../src/tui/line.ts";
import {
  buildSkillRows,
  firstItemIndex,
  moveSkillSel,
  renderSkillsRows,
  scrollFor,
  SKILLS_FOOTER,
  skillsDisplayLines,
  type SkillRow,
} from "../src/tui/skillsView.ts";

const P: Palette = MOONLIT;

const skill = (name: string, description: string, source: string): SkillInfo => ({
  id: name,
  name,
  description,
  source,
});

// What scanSkills() returns: sorted by source, then case-insensitively by name.
const SCAN: SkillInfo[] = [
  skill("alpha", "first skill", "Agents"),
  skill("Beta", "second skill", "Agents"),
  skill("kimi-code", "Kimi Code skill", "Kimi Code"),
  skill("deck", "幻灯片生成", "Plugin: slides"),
];

const W = 60;
const grid = (rows: SkillRow[], sel: number, height: number, loading = false) =>
  renderSkillsRows({ rows, sel, loading, width: W, height, palette: P }).map((l) =>
    lineText(l).replace(/\s+$/, ""),
  );

// REVIEW-RUST Minor 11: scroll_for() is pure so the both-lines-visible
// invariant is unit-testable (mirrors rust/src/ui/skills_view.rs::tests).
describe("skills scroll budget (rust skills_view.rs::scroll_for)", () => {
  test("no scroll while the selection already fits", () => {
    expect(scrollFor(0, 5, 10)).toBe(0);
    expect(scrollFor(3, 5, 10)).toBe(0); // name 3 + desc 4 fit rows 0..=4
  });

  test("paging keeps the selected name AND description visible", () => {
    // name on the last visible row: one line of scroll reveals the description
    expect(scrollFor(4, 5, 10)).toBe(1);
    // paged past the bottom: name and description end on the last two rows
    expect(scrollFor(7, 5, 10)).toBe(4);
  });

  test("max_scroll pins the view to the last page and clamps safely", () => {
    expect(scrollFor(6, 5, 3)).toBe(3); // last page rows 3..=7: name 6, desc 7 visible
    expect(scrollFor(50, 5, 3)).toBe(3); // out-of-range selection clamps
    expect(scrollFor(0, 5, 0)).toBe(0); // short list, nothing to scroll
  });
});

describe("skills row model (app.rs::set_skills)", () => {
  test("groups are inserted whenever the source changes", () => {
    expect(buildSkillRows(SCAN)).toEqual([
      { kind: "group", source: "Agents" },
      { kind: "item", name: "alpha", description: "first skill" },
      { kind: "item", name: "Beta", description: "second skill" },
      { kind: "group", source: "Kimi Code" },
      { kind: "item", name: "kimi-code", description: "Kimi Code skill" },
      { kind: "group", source: "Plugin: slides" },
      { kind: "item", name: "deck", description: "幻灯片生成" },
    ]);
    expect(buildSkillRows([])).toEqual([]);
  });

  test("the highlight starts on the first item and skips headers when moving (SPEC 21.3)", () => {
    const rows = buildSkillRows(SCAN);
    expect(firstItemIndex(rows)).toBe(1);
    expect(moveSkillSel(rows, 1, 1)).toBe(2);
    expect(moveSkillSel(rows, 2, 1)).toBe(4); // over the "Kimi Code" header
    expect(moveSkillSel(rows, 4, 1)).toBe(6); // over the plugin header
    expect(moveSkillSel(rows, 6, 1)).toBe(1); // wraps to the first item
    expect(moveSkillSel(rows, 1, -1)).toBe(6); // wrapping backwards too
    expect(moveSkillSel([], 0, 1)).toBe(0);
  });
});

describe("skills view rows (SPEC 21.3)", () => {
  const rows = buildSkillRows(SCAN);

  test("title, group headers, name and indented description", () => {
    expect(grid(rows, 1, 24)).toEqual([
      "",
      "  Kimi Skills   4 skills",
      "",
      "",
      "Agents",
      "  alpha",
      "    first skill",
      "  Beta",
      "    second skill",
      "",
      "Kimi Code",
      "  kimi-code",
      "    Kimi Code skill",
      "",
      "Plugin: slides",
      "  deck",
      "    幻灯片生成",
    ]);
  });

  test("a rescan shows Scanning... instead of the count", () => {
    expect(grid(rows, 1, 24, true)[1]).toBe("  Kimi Skills   Scanning...");
  });

  test("an empty scan yields a 0 skills summary and no rows", () => {
    expect(grid([], 0, 24)).toEqual(["", "  Kimi Skills   0 skills", "", ""]);
  });

  test("a wide description is truncated at the cell boundary", () => {
    const line = renderSkillsRows({
      rows: [{ kind: "item", name: "n", description: "一二三四五六七八九十" }],
      sel: 0,
      loading: false,
      width: 12,
      height: 24,
      palette: P,
    })[5]!;
    expect(lineWidth(line)).toBe(12);
    expect(lineText(line)).toBe("    一二三四");
  });

  test("the viewport scrolls to keep the selected item's two lines visible (REVIEW-RUST Minor 11)", () => {
    const many: SkillRow[] = [{ kind: "group", source: "Kimi Code" }];
    for (const n of ["a", "b", "c", "d"]) many.push({ kind: "item", name: n, description: `d-${n}` });
    // height 12 -> viewport 7 lines; rows: 0 group, 1..8 items (2 lines each)
    expect(skillsDisplayLines(many, 0, P).rowLine).toEqual([0, 1, 3, 5, 7]);
    const top = grid(many, 1, 12);
    expect(top.slice(4)).toEqual(["Kimi Code", "  a", "    d-a", "  b", "    d-b", "  c", "    d-c"]);
    // the last item starts on line 7: scroll 2 pins its name AND description
    // on the last two viewport rows (the old +1 budget clipped the description)
    const scrolled = grid(many, 4, 12);
    expect(scrolled.slice(4)).toEqual(["    d-a", "  b", "    d-b", "  c", "    d-c", "  d", "    d-d"]);
  });

  test("the selected item highlights both of its lines", () => {
    const lines = skillsDisplayLines(rows, 1, P).lines;
    expect(lines[1]!.spans[0]!.bg).toBe(P.buttonHover);
    expect(lines[1]!.spans[0]!.bold).toBe(true);
    expect(lines[2]!.spans[0]!.bg).toBe(P.buttonHover);
    expect(lines[2]!.spans[0]!.bold).toBeUndefined();
    expect(lines[3]!.spans[0]!.bg).toBeUndefined(); // "  Beta" is not selected
  });

  test("group headers are accent + bold, and every row fills the width", () => {
    const rendered = renderSkillsRows({ rows, sel: 1, loading: false, width: 72, height: 24, palette: P });
    expect(rendered[4]!.spans[0]!.fg).toBe(P.accent);
    expect(rendered[4]!.spans[0]!.bold).toBe(true);
    for (const l of rendered) expect(lineWidth(l)).toBe(72);
  });

  test("the footer is the SPEC 21.3 key hint", () => {
    expect(SKILLS_FOOTER).toBe("↑/↓ Scroll · r Rescan · Esc Back · q Quit");
  });
});
