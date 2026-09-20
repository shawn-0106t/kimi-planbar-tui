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

  test("the viewport scrolls to keep the selected row visible", () => {
    const many: SkillRow[] = [{ kind: "group", source: "Kimi Code" }];
    for (const n of ["a", "b", "c", "d"]) many.push({ kind: "item", name: n, description: `d-${n}` });
    // height 12 -> viewport 7 lines; rows: 0 group, 1..8 items (2 lines each)
    expect(skillsDisplayLines(many, 0, P).rowLine).toEqual([0, 1, 3, 5, 7]);
    const top = grid(many, 1, 12);
    expect(top.slice(4)).toEqual(["Kimi Code", "  a", "    d-a", "  b", "    d-b", "  c", "    d-c"]);
    // the last item starts on line 7, outside a 7-line viewport -> scroll 1
    const scrolled = grid(many, 4, 12);
    expect(scrolled.slice(4)).toEqual(["  a", "    d-a", "  b", "    d-b", "  c", "    d-c", "  d"]);
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
